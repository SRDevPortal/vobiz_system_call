"""Real heartbeat lock contention on a disposable socket-only MariaDB server.

No site configuration or site database is used. Run as a non-root developer
with mariadbd and mariadb-install-db available.
"""
from contextlib import nullcontext
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import frappe
import pymysql
from vobiz_system_call.api import lifecycle, ownership, webrtc


class Database:
    def __init__(self, connection):
        self.connection = connection

    def sql(self, query, values=None):
        try:
            with self.connection.cursor() as cursor:
                cursor.execute(query, values)
                return cursor.fetchall()
        except pymysql.err.OperationalError as error:
            if error.args[0] == 1205:
                raise frappe.QueryTimeoutError(error) from error
            if error.args[0] == 1213:
                raise frappe.QueryDeadlockError(error) from error
            raise

    def rollback(self):
        self.connection.rollback()

    def commit(self):
        self.connection.commit()


@unittest.skipUnless(shutil.which('mariadbd') and shutil.which('mariadb-install-db'), 'MariaDB tools required')
class PresenceMariaDBTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.folder = tempfile.TemporaryDirectory(prefix='vobiz-presence-')
        cls.addClassCleanup(cls.folder.cleanup)
        root = Path(cls.folder.name)
        output = (root/'bootstrap.log').open('w')
        cls.addClassCleanup(output.close)
        subprocess.run(['mariadb-install-db', '--no-defaults', '--datadir='+str(root/'data'),
                        '--auth-root-authentication-method=normal', '--skip-test-db'],
                       check=True, stdout=output, stderr=subprocess.STDOUT, timeout=45)
        cls.socket = str(root/'db.sock')
        server = subprocess.Popen(['mariadbd', '--no-defaults', '--datadir='+str(root/'data'),
            '--socket='+cls.socket, '--pid-file='+str(root/'db.pid'), '--skip-networking',
            '--skip-log-bin', '--innodb-buffer-pool-size=64M', '--max-connections=10',
            '--log-error='+str(root/'server.log')], stdout=output, stderr=subprocess.STDOUT)
        def stop():
            server.terminate()
            server.wait(timeout=20)
        cls.addClassCleanup(stop)
        for _ in range(200):
            try:
                admin = pymysql.connect(unix_socket=cls.socket, user='root', autocommit=True)
                break
            except pymysql.err.OperationalError:
                if server.poll() is not None:
                    raise RuntimeError((root/'server.log').read_text())
                time.sleep(.1)
        else:
            raise RuntimeError('Disposable MariaDB startup timed out')
        cls.addClassCleanup(admin.close)
        with admin.cursor() as cursor:
            cursor.execute('CREATE DATABASE presence_test')
        cls.connections = [pymysql.connect(unix_socket=cls.socket, user='root',
                           database='presence_test', autocommit=False) for _ in range(2)]
        for connection in cls.connections:
            cls.addClassCleanup(connection.close)
        cls.writer, cls.reader = [Database(connection) for connection in cls.connections]
        cls.writer.sql('CREATE TABLE `tabVobiz User Mapping` (name varchar(140) PRIMARY KEY, current_call_log varchar(140)) ENGINE=InnoDB')
        cls.writer.sql("INSERT INTO `tabVobiz User Mapping` VALUES ('agent', '')")
        cls.writer.commit()

    def test_busy_heartbeat_returns_promptly_and_rereads_committed_call_on_retry(self):
        cache = MagicMock()
        cache.lock.side_effect = lambda *a, **kw: nullcontext()
        cache.get_value.return_value = 'owner-window'
        def get_doc(doctype, name, *, for_update):
            self.assertTrue(for_update)
            row = self.reader.sql('SELECT current_call_log FROM `tabVobiz User Mapping` WHERE name=%s FOR UPDATE', name)[0]
            return frappe._dict(name=name, user='agent', enabled=1, browser_softphone_enabled=1,
                                current_call_log=row[0])
        self.writer.sql("UPDATE `tabVobiz User Mapping` SET current_call_log='LIVE-CALL' WHERE name='agent'")
        self.addCleanup(self.writer.rollback)
        self.addCleanup(self.reader.rollback)
        with patch.object(frappe, 'db', self.reader), \
                patch.object(frappe, 'session', SimpleNamespace(user='agent')), \
                patch.object(frappe, 'cache', lambda: cache), \
                patch.object(webrtc, '_login'), patch.object(webrtc, '_browser_enabled', return_value=True), \
                patch.object(lifecycle.core_call, 'get_user_mapping', return_value={'name': 'agent'}), \
                patch.object(frappe, 'get_doc', side_effect=get_doc), \
                patch.object(lifecycle, 'presence', return_value='owner-window'):
            started = time.monotonic()
            result = ownership.presence_heartbeat('other-window', claim_idle=1)
            self.assertEqual(result['ownership'], 'retry')
            self.assertLess(time.monotonic() - started, 1.5)
            cache.set_value.assert_not_called()
            cache.delete_value.assert_not_called()
            self.writer.commit()
            # A different window cannot claim an active call after contention.
            cache.get_value.side_effect = lambda key, **kw: 'owner-window' if key.startswith('vsc:browser-owner:') else None
            result = ownership.presence_heartbeat('other-window', claim_idle=1)
            self.assertEqual(result['ownership'], 'active_call')
            cache.set_value.assert_not_called()
            # The returned heartbeat has committed and released its row lock.
            self.writer.sql("SELECT name FROM `tabVobiz User Mapping` WHERE name='agent' FOR UPDATE NOWAIT")
