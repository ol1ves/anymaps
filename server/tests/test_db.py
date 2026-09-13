from server.app.db import connect


def test_connect_creates_all_tables(tmp_path):
    conn = connect(str(tmp_path / "test.db"))
    names = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
    }
    assert {"widgets", "channels", "instances", "records", "secrets"} <= names
    conn.close()
