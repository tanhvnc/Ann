import unittest
from types import SimpleNamespace
from unittest.mock import patch

import app
from fastapi import HTTPException


class FakeSupabaseClient:
    def __init__(self):
        self.inserted_payloads = []
        self.deleted_person = None

    def table(self, table_name):
        self.table_name = table_name
        return self

    def select(self, *args, **kwargs):
        return self

    def insert(self, payload):
        self.inserted_payloads.append(payload)
        return self

    def delete(self):
        return self

    def eq(self, column, value):
        self.deleted_person = value
        return self

    def in_(self, column, values):
        return self

    def execute(self):
        return SimpleNamespace(data=[{"id": "fake-id"}])


class PeopleApiTests(unittest.TestCase):
    def test_create_person_persists_name_to_backend(self):
        fake_client = FakeSupabaseClient()

        with patch.object(app, "supabase", fake_client):
            response = app.create_person(app.PersonCreate(name="Alice"))

        self.assertEqual(response["status"], "ok")
        self.assertEqual(fake_client.table_name, "events")
        self.assertEqual(fake_client.inserted_payloads[-1]["person"], "Alice")
        self.assertEqual(fake_client.inserted_payloads[-1]["title"], "__person_placeholder__")

    def test_delete_person_removes_records_for_that_person(self):
        fake_client = FakeSupabaseClient()

        with patch.object(app, "supabase", fake_client):
            response = app.delete_person("Alice")

        self.assertEqual(response["status"], "ok")
        self.assertEqual(fake_client.table_name, "events")

    def test_create_item_returns_generic_internal_error_message(self):
        class FailingClient(FakeSupabaseClient):
            def table(self, table_name):
                self.table_name = table_name
                return self

            def select(self, *args, **kwargs):
                return self

            def eq(self, column, value):
                return self

            def execute(self):
                raise RuntimeError("boom")

        fake_client = FailingClient()

        with patch.object(app, "supabase", fake_client):
            with self.assertRaises(HTTPException) as ctx:
                app.create_item(app.ItemCreate(event_id="event-1", description="Lunch", amount=12.5), user_id="user-1")

        self.assertEqual(ctx.exception.status_code, 500)
        self.assertEqual(ctx.exception.detail, "Internal Server Error")


if __name__ == "__main__":
    unittest.main()
