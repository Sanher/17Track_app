import json
import os
import tempfile
import unittest
from datetime import date
from email.message import EmailMessage
from pathlib import Path
from unittest.mock import patch

import scripts.imap_ingest_worker as worker


class DotenvLoadingTests(unittest.TestCase):
    def test_load_dotenv_defaults_supports_multiline_json(self):
        with tempfile.TemporaryDirectory() as td:
            env_path = Path(td) / ".env"
            env_path.write_text(
                "\n".join(
                    [
                        "IMAP_ACCOUNTS_JSON=[",
                        '  {"email":"a@gmail.com","owner":"owner_a","auth":"password","password_env":"PW"}',
                        "]",
                        "PW=secret_pw",
                        'KEEP_ME="from_file"',
                    ]
                ),
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"KEEP_ME": "from_env"}, clear=False):
                os.environ.pop("IMAP_ACCOUNTS_JSON", None)
                os.environ.pop("PW", None)
                worker.load_dotenv_defaults(env_path)

                self.assertEqual(os.environ["KEEP_ME"], "from_env")
                self.assertEqual(os.environ["PW"], "secret_pw")
                parsed = json.loads(os.environ["IMAP_ACCOUNTS_JSON"])
                self.assertEqual(parsed[0]["email"], "a@gmail.com")


class AccountNormalizationTests(unittest.TestCase):
    def test_normalize_account_gmail_uses_password_env_and_filters(self):
        with patch.dict(os.environ, {"IMAP_GMAIL_1_APP_PASSWORD": "pw_123"}, clear=False):
            account = worker.normalize_account(
                {
                    "email": "USER@gmail.com",
                    "owner": "owner_a",
                    "provider": "gmail",
                    "auth": "password",
                    "password_env": "IMAP_GMAIL_1_APP_PASSWORD",
                    "filters": {
                        "only_amazon": "true",
                        "allowed_sender_domains": [" Amazon.es ", "amazon.com"],
                        "destination_keywords_all": "Mislata",
                        "require_dkim_pass": "true",
                    },
                },
                default_owner="",
            )

        self.assertEqual(account["email"], "user@gmail.com")
        self.assertEqual(account["host"], "imap.gmail.com")
        self.assertEqual(account["password"], "pw_123")
        self.assertTrue(account["filters"]["only_amazon"])
        self.assertEqual(account["filters"]["allowed_sender_domains"], ["amazon.es", "amazon.com"])
        self.assertEqual(account["filters"]["destination_keywords_all"], ["mislata"])
        self.assertTrue(account["filters"]["require_dkim_pass"])

    def test_normalize_account_disabled_allows_missing_owner_and_secret(self):
        account = worker.normalize_account(
            {
                "email": "disabled@gmail.com",
                "enabled": False,
                "provider": "gmail",
                "auth": "password",
            },
            default_owner="",
        )

        self.assertFalse(account["enabled"])
        self.assertEqual(account["owner"], "_disabled")
        self.assertNotIn("password", account)

    def test_load_accounts_from_file_uses_default_owner(self):
        with tempfile.TemporaryDirectory() as td:
            accounts_path = Path(td) / "accounts.json"
            accounts_path.write_text(
                json.dumps(
                    [
                        {
                            "email": "one@gmail.com",
                            "auth": "password",
                            "password_env": "PW_FILE",
                        }
                    ]
                ),
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {
                    "IMAP_ACCOUNTS_FILE": str(accounts_path),
                    "IMAP_ACCOUNTS_JSON": "",
                    "IMAP_DEFAULT_OWNER": "owner_file",
                    "PW_FILE": "pw_from_file",
                },
                clear=False,
            ):
                accounts = worker.load_accounts()

        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["owner"], "owner_file")
        self.assertEqual(accounts[0]["password"], "pw_from_file")

    def test_load_accounts_defaults_owner_to_unnamed(self):
        with patch.dict(
            os.environ,
            {
                "IMAP_ACCOUNTS_JSON": json.dumps(
                    [
                        {
                            "email": "unnamed@gmail.com",
                            "auth": "password",
                            "password_env": "PW_UNNAMED",
                        }
                    ]
                ),
                "PW_UNNAMED": "pw_unnamed",
            },
            clear=False,
        ):
            os.environ.pop("IMAP_DEFAULT_OWNER", None)
            accounts = worker.load_accounts()

        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["owner"], "unnamed")
        self.assertEqual(accounts[0]["password"], "pw_unnamed")

    def test_load_accounts_raises_when_password_missing(self):
        with patch.dict(
            os.environ,
            {
                "IMAP_ACCOUNTS_JSON": json.dumps(
                    [
                        {
                            "email": "missing@gmail.com",
                            "owner": "owner_a",
                            "auth": "password",
                            "password_env": "PW_DOES_NOT_EXIST",
                        }
                    ]
                )
            },
            clear=False,
        ):
            os.environ.pop("PW_DOES_NOT_EXIST", None)
            with self.assertRaises(RuntimeError) as ctx:
                worker.load_accounts()

        self.assertIn("password_missing", str(ctx.exception))

    def test_temporary_account_block_for_email_is_active_before_deadline(self):
        blocked = worker.temporary_account_block_for_email(
            "mahlerthedog@gmail.com",
            today=date(2026, 3, 24),
        )

        self.assertIsNotNone(blocked)
        self.assertEqual(blocked["disabled_until"], "2026-06-24")

    def test_temporary_account_block_for_email_expires_on_deadline(self):
        blocked = worker.temporary_account_block_for_email(
            "mahlerthedog@gmail.com",
            today=date(2026, 6, 24),
        )

        self.assertIsNone(blocked)


class FilteringTests(unittest.TestCase):
    def test_message_passes_filters_for_amazon_mislata(self):
        account = {
            "filters": {
                "only_amazon": True,
                "allowed_sender_domains": ["amazon.es"],
                "destination_keywords_all": ["mislata"],
                "require_dkim_pass": True,
            }
        }
        ok, reason = worker.message_passes_filters(
            account=account,
            sender="Amazon.es <shipment-tracking@amazon.es>",
            subject="Tu pedido Amazon en reparto",
            body="Direccion de entrega: Mislata, Valencia",
            auth_flags={"dkim_pass": True, "spf_pass": False, "dmarc_pass": False},
        )
        self.assertTrue(ok)
        self.assertEqual(reason, "filters_pass")

    def test_message_filters_reject_disallowed_sender_domain(self):
        account = {"filters": {"allowed_sender_domains": ["amazon.es"]}}
        ok, reason = worker.message_passes_filters(
            account=account,
            sender="Scam <fake@amaz0n.es>",
            subject="Amazon delivery",
            body="Mislata",
            auth_flags={},
        )
        self.assertFalse(ok)
        self.assertEqual(reason, "sender_domain_not_allowed")

    def test_message_filters_reject_missing_keyword_or_auth(self):
        account = {
            "filters": {
                "required_keywords_all": ["mislata"],
                "require_spf_pass": True,
            }
        }
        ok, reason = worker.message_passes_filters(
            account=account,
            sender="Amazon <shipment-tracking@amazon.es>",
            subject="Tu paquete en reparto",
            body="Entrega en Valencia",
            auth_flags={"spf_pass": False},
        )
        self.assertFalse(ok)
        self.assertTrue(reason.startswith("missing_keywords_all:"))


class ExtractionAndAuthTests(unittest.TestCase):
    def test_extract_tracking_numbers_detects_strong_patterns(self):
        found = worker.extract_tracking_numbers(
            subject="Tracking 1Z999AA10123456784",
            body="Your package shipped",
        )
        self.assertIn("1Z999AA10123456784", found)

    def test_extract_tracking_numbers_weak_tokens_require_shipping_context(self):
        weak_token = "AMZ-ORDER-123456"
        without_context = worker.extract_tracking_numbers(
            subject=f"Codigo {weak_token}",
            body="mensaje de prueba sin contexto",
        )
        with_context = worker.extract_tracking_numbers(
            subject=f"Codigo {weak_token}",
            body="your package shipped today",
        )

        self.assertNotIn(weak_token, without_context)
        self.assertIn(weak_token, with_context)

    def test_message_auth_flags_reads_authentication_results(self):
        msg = EmailMessage()
        msg["Authentication-Results"] = "mx; dkim=pass header.i=@amazon.es; spf=pass; dmarc=fail"

        flags = worker.message_auth_flags(msg)
        self.assertTrue(flags["dkim_pass"])
        self.assertTrue(flags["spf_pass"])
        self.assertFalse(flags["dmarc_pass"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
