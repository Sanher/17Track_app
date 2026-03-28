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

    def test_account_block_for_email_keeps_mahler_disabled_until_manual_reenable(self):
        blocked = worker.account_block_for_email(
            "mahlerthedog@gmail.com",
            today=date(2026, 3, 24),
        )

        self.assertIsNotNone(blocked)
        self.assertEqual(blocked["mode"], "permanent")
        self.assertEqual(blocked["disabled_until"], "manual_reenable")

    def test_load_accounts_skips_permanently_disabled_account(self):
        with patch.dict(
            os.environ,
            {
                "IMAP_ACCOUNTS_JSON": json.dumps(
                    [
                        {
                            "email": "mahlerthedog@gmail.com",
                            "owner": "mireia",
                            "auth": "password",
                            "password_env": "PW_MAHLER",
                        },
                        {
                            "email": "active@gmail.com",
                            "owner": "david",
                            "auth": "password",
                            "password_env": "PW_ACTIVE",
                        },
                    ]
                ),
                "PW_MAHLER": "pw_disabled",
                "PW_ACTIVE": "pw_active",
            },
            clear=False,
        ):
            accounts = worker.load_accounts()

        self.assertEqual(len(accounts), 1)
        self.assertEqual(accounts[0]["email"], "active@gmail.com")


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

    def test_message_matches_ignore_rule_for_same_account(self):
        matched, reason = worker.message_matches_ignore_rule(
            account={"email": "owner@gmail.com"},
            subject="Boleto Euromillones ICOVVTV09154 validado",
            body="Consulta tu combinacion",
            ignore_rules=[
                {
                    "id": "rule_1",
                    "kind": "subject_terms_all",
                    "account_email": "owner@gmail.com",
                    "description_terms": ["boleto", "euromillones", "validado"],
                    "active": True,
                }
            ],
        )

        self.assertTrue(matched)
        self.assertEqual(reason, "rule_1")

    def test_message_matches_ignore_rule_does_not_block_other_account(self):
        matched, _reason = worker.message_matches_ignore_rule(
            account={"email": "other@gmail.com"},
            subject="Boleto Euromillones ICOVVTV09154 validado",
            body="Consulta tu combinacion",
            ignore_rules=[
                {
                    "id": "rule_1",
                    "kind": "subject_terms_all",
                    "account_email": "owner@gmail.com",
                    "description_terms": ["boleto", "euromillones", "validado"],
                    "active": True,
                }
            ],
        )

        self.assertFalse(matched)

    def test_non_package_signature_rejects_lottery_and_linkedin_noise(self):
        self.assertTrue(
            worker.looks_like_non_package_message(
                sender="Loterias <news@example.com>",
                subject="Boleto Euromillones ICOVVTV09154 validado",
                body="Resultado del sorteo",
            )
        )
        self.assertTrue(
            worker.looks_like_non_package_message(
                sender="LinkedIn <jobs-noreply@linkedin.com>",
                subject="Job alert: nuevas vacantes",
                body="empleo y vacantes recomendadas",
            )
        )
        self.assertTrue(
            worker.looks_like_non_package_message(
                sender="Promo <rewards@example.com>",
                subject="¡Canjea tus pasos antes de la medianoche!",
                body="Reclama tu premio esta noche",
            )
        )
        self.assertFalse(
            worker.looks_like_non_package_message(
                sender="Amazon <shipment-tracking@amazon.es>",
                subject="Tu paquete Amazon en reparto",
                body="Seguimiento del paquete y entrega hoy",
            )
        )


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

    def test_extract_tracking_numbers_does_not_treat_generic_order_word_as_shipping_context(self):
        found = worker.extract_tracking_numbers(
            subject="La Semana Santa sabe a bacalao... 💛",
            body="Tu pedido WEB-9102755 sigue pendiente",
        )

        self.assertEqual(found, [])

    def test_extract_tracking_numbers_rejects_hex_noise_even_with_shipping_context(self):
        found = worker.extract_tracking_numbers(
            subject="Seguimiento disponible",
            body="Seguimiento del envio B8531D5B9FC4 y F907C830-34E1-485B-ABE8",
        )

        self.assertEqual(found, [])

    def test_extract_tracking_numbers_accepts_weak_token_from_official_carrier_sender(self):
        weak_token = "GLS-ES-12345678"
        found = worker.extract_tracking_numbers(
            subject=f"Referencia {weak_token}",
            body="mensaje breve sin palabras de envio",
            sender="GLS <noreply@gls-group.eu>",
        )

        self.assertIn(weak_token, found)

    def test_extract_tracking_numbers_accepts_amazon_order_id_from_official_sender(self):
        found = worker.extract_tracking_numbers(
            subject="Pedido: producto de prueba",
            body="Gracias por tu pedido. Pedido n.º 171-6273296-7097149",
            sender="Amazon.es <auto-confirm@amazon.es>",
        )

        self.assertEqual(found, ["171-6273296-7097149"])

    def test_extract_tracking_numbers_strips_quoted_printable_garbage_for_amazon_sender(self):
        found = worker.extract_tracking_numbers(
            subject='Fwd: Pedido: "Oral-B Pro CrossAction..."',
            body="Pedido n.º =3D405-0201761-6227578 texto =20O0ZVWEXWRVQN y =35VDYOD7RE69T y enlace GD1MOZ5VDE85",
            sender="Amazon.es <auto-confirm@amazon.es>",
        )

        self.assertEqual(found, ["405-0201761-6227578"])

    def test_message_auth_flags_reads_authentication_results(self):
        msg = EmailMessage()
        msg["Authentication-Results"] = "mx; dkim=pass header.i=@amazon.es; spf=pass; dmarc=fail"

        flags = worker.message_auth_flags(msg)
        self.assertTrue(flags["dkim_pass"])
        self.assertTrue(flags["spf_pass"])
        self.assertFalse(flags["dmarc_pass"])

    def test_resolve_sender_header_uses_reply_to_when_from_missing(self):
        msg = EmailMessage()
        msg["Reply-To"] = "Promo <rewards@example.com>"

        self.assertEqual(worker.resolve_sender_header(msg), "Promo <rewards@example.com>")

    def test_guess_carrier_does_not_prefer_generic_correos_from_body(self):
        carrier = worker.guess_carrier(
            sender="GLS <tracking@gls.com>",
            subject="Tu paquete GLS esta en camino",
            body="Si no quieres recibir mas correos, actualiza tus preferencias",
        )

        self.assertEqual(carrier, "GLS")

    def test_guess_carrier_prefers_official_sender_rules(self):
        self.assertEqual(
            worker.guess_carrier(
                sender="UPS <customer-notifications@ups.com>",
                subject="Actualizacion",
                body="Mensaje corto",
            ),
            "UPS",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="SEUR <infoenvios@mail.seur.info>",
                subject="Aviso",
                body="Mensaje corto",
            ),
            "SEUR",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="DHL <noreply@dhl.de>",
                subject="Actualizacion",
                body="Mensaje corto",
            ),
            "DHL",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="Correos <aviso@correos.es>",
                subject="Actualizacion",
                body="Mensaje corto",
            ),
            "Correos España",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="amazon shipping <no-reply@shipping.amazon.es>",
                subject="Tu paquete esta en reparto",
                body="Rastrear y gestionar paquete",
            ),
            "Amazon",
        )

    def test_guess_carrier_supports_curated_exact_sender_addresses(self):
        self.assertEqual(
            worker.guess_carrier(
                sender="TIPSA <no-reply@tip-sa.com>",
                subject="Aviso",
                body="Mensaje corto",
            ),
            "TIPSA",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="CTT <noreplyclientes@cttexpress.org>",
                subject="Aviso",
                body="Mensaje corto",
            ),
            "CTT Express",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="Correos Express <no-reply@correosexpress.com>",
                subject="Aviso",
                body="Mensaje corto",
            ),
            "Correos Express",
        )
        self.assertEqual(
            worker.guess_carrier(
                sender="InPost <no_reply@info.inpost.es>",
                subject="Aviso",
                body="Mensaje corto",
            ),
            "InPost",
        )

    def test_merchant_sender_catalog_is_not_treated_as_carrier_yet(self):
        self.assertIsNone(worker.official_carrier_from_sender("DOMADOO <assistance@domadoo.com>"))
        self.assertIsNone(worker.official_carrier_from_sender("MIRAVIA <miravia@service.miravia.es>"))


class ProcessAccountTests(unittest.TestCase):
    def test_process_account_marks_package_like_without_tracking(self):
        msg = EmailMessage()
        msg["Subject"] = "Tu envio ya esta en camino"
        msg["From"] = "DHL <noreply@dhl.de>"
        msg["Date"] = "Wed, 25 Mar 2026 10:00:00 +0000"
        msg.set_content("Consulta el estado de tu envio en la app.")

        class DummyClient:
            def close(self):
                return None

            def logout(self):
                return None

        with patch.object(worker, "login_imap", return_value=DummyClient()), patch.object(
            worker, "list_new_uids", return_value=[1]
        ), patch.object(worker, "fetch_message", return_value=msg):
            items, max_uid, scanned, filtered_out, filtered_reasons, filtered_samples = worker.process_account(
                account={
                    "email": "demo@example.com",
                    "owner": "owner_a",
                    "provider": "outlook",
                    "mailbox": "INBOX",
                    "auth": "password",
                    "username": "demo@example.com",
                    "password": "pw",
                    "filters": {},
                },
                last_uid=0,
                lookback_days=60,
                fetch_limit=120,
                timeout_sec=20,
                ignore_rules=[],
            )

        self.assertEqual(items, [])
        self.assertEqual(max_uid, 1)
        self.assertEqual(scanned, 1)
        self.assertEqual(filtered_out, 1)
        self.assertEqual(filtered_reasons["package_like_but_no_tracking"], 1)
        self.assertEqual(filtered_samples["package_like_but_no_tracking"][0]["subject"], "Tu envio ya esta en camino")

    def test_classify_status_supports_amazon_order_and_shipping_messages(self):
        status_order, _note_order = worker.classify_status(
            subject="Pedido: producto de prueba",
            body="Gracias por tu pedido. Pedido n.º 171-6273296-7097149",
            sender="Amazon.es <auto-confirm@amazon.es>",
        )
        status_shipped, _note_shipped = worker.classify_status(
            subject="Tu paquete se ha enviado",
            body="¡Tu paquete se ha enviado! Pedido n.º 406-5156836-6489112",
            sender="Amazon.es <confirmar-envio@amazon.es>",
        )
        status_ofd, _note_ofd = worker.classify_status(
            subject="Tu paquete está en reparto",
            body="Tu paquete está en reparto. Rastrear y gestionar paquete",
            sender="amazon shipping <no-reply@shipping.amazon.es>",
        )

        self.assertEqual(status_order, "info_received")
        self.assertEqual(status_shipped, "in_transit")
        self.assertEqual(status_ofd, "out_for_delivery")


class WorkerMainTests(unittest.TestCase):
    def test_main_returns_zero_when_some_accounts_fail(self):
        account = {
            "owner": "david",
            "email": "ressetbsg@hotmail.com",
            "provider": "outlook",
            "mailbox": "INBOX",
        }

        with patch.object(worker, "load_dotenv_defaults"), \
             patch.object(worker, "load_accounts", return_value=[account]), \
             patch.object(worker, "load_state", return_value={"accounts": {}}), \
             patch.object(worker, "save_state"), \
             patch.object(worker, "post_account_binding", return_value={}), \
             patch.object(worker, "fetch_ignore_rules", return_value=[]), \
             patch.object(worker, "process_account", side_effect=worker.imaplib.IMAP4.error("AUTH failed")):
            result = worker.main()

        self.assertEqual(result, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
