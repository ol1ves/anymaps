"""External channel poller (SPEC §10). Full implementation lands in Task 8."""


class Poller:
    def __init__(self, db):
        self.db = db
        self.tasks = {}

    def start_all(self):
        pass

    async def shutdown(self):
        pass
