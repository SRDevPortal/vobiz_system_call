import ast
from pathlib import Path
from types import SimpleNamespace
import unittest


class IndexInstallTest(unittest.TestCase):
    def test_pending_writes_and_repeated_install(self):
        source = Path(__file__).resolve().parents[1] / "install.py"
        tree = ast.parse(source.read_text())
        function = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "ensure_indexes")

        class Database:
            pending_writes = True
            indexes = set()
            ddl = []

            def sql(self, query, values=None):
                if query.startswith("SELECT"):
                    return [(values[1],)] if values[1] in self.indexes else []
                if self.pending_writes:
                    raise RuntimeError("This statement can cause implicit commit")
                self.ddl.append(query)
                self.indexes.add(query.split("ADD INDEX `")[1].split("`")[0])

            def sql_ddl(self, query):
                self.pending_writes = False
                self.sql(query)

        db = Database()
        namespace = {"frappe": SimpleNamespace(db=db)}
        exec(compile(ast.Module(body=[function], type_ignores=[]), str(source), "exec"), namespace)
        namespace["ensure_indexes"]()
        self.assertEqual(db.indexes, {"vsc_endpoint", "vsc_did"})
        self.assertEqual(len(db.ddl), 2)
        self.assertTrue(all("ALGORITHM=INPLACE, LOCK=NONE" in query for query in db.ddl))
        db.pending_writes = True
        namespace["ensure_indexes"]()
        self.assertEqual(len(db.ddl), 2)
        self.assertTrue(db.pending_writes)
