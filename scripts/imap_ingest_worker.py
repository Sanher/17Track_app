#!/usr/bin/env python3
"""
IMAP -> ingest worker.

Reads multiple email accounts (Gmail app password or Outlook OAuth2),
extracts tracking-like updates from new emails, and pushes them to:
POST /api/owner/:owner/imap/ingest
"""

from __future__ import annotations

import html
import imaplib
import json
import os
import re
import sys
import traceback
from datetime import date, datetime, timedelta, timezone
from email import policy
from email.header import decode_header, make_header
from email.parser import BytesParser
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


TRUE_VALUES = {"1", "true", "yes", "y", "on"}
FALSE_VALUES = {"0", "false", "no", "n", "off"}

DEFAULT_BASE_URL = "http://127.0.0.1:8787"
DEFAULT_STATE_PATH = "./data/imap_worker_state.json"
DEFAULT_LOOKBACK_DAYS = 60
DEFAULT_FETCH_LIMIT = 120
DEFAULT_BATCH_SIZE = 100
DEFAULT_TIMEOUT_SEC = 20
DEFAULT_DOTENV_PATH = ".env"
DEFAULT_IGNORE_RULES_TIMEOUT_SEC = 10

# Code-level account disables without touching IMAP account config.
# Remove an entry here when the account should become active again.
PERMANENT_ACCOUNT_BLOCKS: dict[str, dict[str, Any]] = {
    "mahlerthedog@gmail.com": {
        "disabled_until": "manual_reenable",
        "reason": "IMAP 4 desactivado por codigo hasta reactivacion manual",
    }
}

TEMPORARY_ACCOUNT_BLOCKS: dict[str, dict[str, Any]] = {}

TRACKING_STRONG_PATTERNS = [
    re.compile(r"\b1Z[0-9A-Z]{16}\b"),  # UPS
    re.compile(r"\bTBA[0-9]{12}\b"),  # Amazon Logistics
    re.compile(r"\b[A-Z]{2}[0-9]{9}[A-Z]{2}\b"),  # UPU
    re.compile(r"\b(?:94|93|92|95)[0-9]{20,22}\b"),  # USPS families
    re.compile(r"\b[0-9]{18,22}\b"),  # long numeric IDs
]
TRACKING_WEAK_PATTERN = re.compile(r"(?<![=])\b[A-Z0-9][A-Z0-9-]{7,34}\b")
AMAZON_ORDER_ID_PATTERN = re.compile(r"(?:=3D)?(\d{3}-\d{7}-\d{7})\b")

SHIPPING_KEYWORDS = {
    "tracking",
    "shipment",
    "shipped",
    "delivery",
    "deliver",
    "parcel",
    "package",
    "envio",
    "enviado",
    "seguimiento",
    "reparto",
    "entrega",
    "paquete",
}

TRACKING_STOPWORDS = {
    "DELIVERED",
    "DELIVERY",
    "TRACKING",
    "SHIPMENT",
    "PACKAGE",
    "PARCEL",
    "ORDER",
    "ESTIMATED",
    "PENDING",
    "CONFIRMED",
    "ARRIVING",
    "ARRIVAL",
    "OUTFORDELIVERY",
    "INTRANSIT",
}

DELIVERED_KEYWORDS = [
    "delivered",
    "entregado",
    "entregada",
    "ha sido entregado",
    "your package was delivered",
]
OUT_FOR_DELIVERY_KEYWORDS = [
    "out for delivery",
    "out-for-delivery",
    "en reparto",
    "sale a reparto",
]
EXCEPTION_KEYWORDS = [
    "exception",
    "delay",
    "demora",
    "failed delivery",
    "delivery attempted",
    "attempted delivery",
    "incidencia",
]
LABEL_KEYWORDS = [
    "label created",
    "shipping label",
    "pre-shipment",
    "preparando",
    "preparation",
]

CARRIER_HINTS = [
    ("amazon", "Amazon"),
    ("ups", "UPS"),
    ("dhl", "DHL"),
    ("fedex", "FedEx"),
    ("usps", "USPS"),
    ("correos", "Correos España"),
    ("seur", "SEUR"),
    ("gls", "GLS"),
    ("mrw", "MRW"),
    ("ctt", "CTT"),
]

# Seeded from official anti-phishing/help pages published by carriers plus
# validated real-world samples. This is intentionally partial and conservative:
# we use it as a positive signal for carrier detection, not as a hard allowlist
# for all package emails.
OFFICIAL_CARRIER_SENDERS: dict[str, dict[str, list[str]]] = {
    "UPS": {
        "emails": [
            "accountconfirm@ups.com",
            "mcinfo@ups.com",
            "pkginfo@ups.com",
            "customer-notifications@ups.com",
            "auto-notify@ups.com",
            "emailinfo@ups.com",
            "invoice-notification@ups.com",
            "upsadministrationsupport@ups.com",
            "donotreply@ups.com",
        ],
        "domains": ["ups.com"],
    },
    "SEUR": {
        "emails": [
            "infoenvios@mail.seur.info",
            "seur@network1.pickup-services.com",
        ],
        "domains": ["mail.seur.info", "network1.pickup-services.com", "seur.com"],
    },
    "DHL": {
        "emails": ["noreply@dhl.com", "noreplyparcel.spain@dhl.com", "noreply@dhl.de"],
        "domains": ["dhl.com", "dpdhl.com", "dhl.de", "dhl.fr", "dhl-news.com"],
    },
    "GLS": {
        "emails": ["noreply@comunicaciones.gls-spain.com"],
        "domains": [
            "gls-group.eu",
            "glsdanmark.dk",
            "gls-denmark.com",
            "gls-netherlands.com",
            "gls.nl",
            "comunicaciones.gls-spain.com",
            "gls-spain.com",
        ],
    },
    "TIPSA": {
        "emails": ["no-reply@tip-sa.com"],
        "domains": ["tip-sa.com"],
    },
    "CTT Express": {
        "emails": ["noreplyclientes@cttexpress.org"],
        "domains": ["cttexpress.org"],
    },
    "FedEx": {
        "emails": ["noreply@fedex.com"],
        "domains": ["fedex.com"],
    },
    "Correos España": {
        "emails": ["correos@correos.com"],
        "domains": ["correos.es", "correos.com"],
    },
    "Celeritas": {
        "emails": ["no-reply@celeritastransporte.com"],
        "domains": ["celeritastransporte.com"],
    },
    "Envialia": {
        "emails": ["maildelivery@envialia.com"],
        "domains": ["envialia.com"],
    },
    "Correos Express": {
        "emails": ["no-reply@correosexpress.com"],
        "domains": ["correosexpress.com"],
    },
    "InPost": {
        "emails": ["no_reply@info.inpost.es"],
        "domains": ["info.inpost.es", "inpost.es"],
    },
    "Ecoscooting": {
        "emails": ["noreply@service.ecoscooting.com"],
        "domains": ["service.ecoscooting.com", "ecoscooting.com"],
    },
    "MRW": {
        "emails": ["no_reply@mrw.es"],
        "domains": ["mrw.es"],
    },
}

# Kept separate on purpose: these are merchant senders that may talk about
# shipments, but we do not elevate them to carrier-like trust until their
# templates are reviewed in more detail to avoid order/payment/promotional
# false positives.
KNOWN_MERCHANT_SENDERS: dict[str, list[str]] = {
    "DOMADOO": ["assistance@domadoo.com"],
    "MIRAVIA": ["miravia@service.miravia.es"],
    "NATULIM": ["natulim@natulim.com"],
    "XIAOMI": ["noreply@notice.xiaomi.com"],
    "SHIPPY PRO": ["no-reply@shippypro.com"],
}

OFFICIAL_AMAZON_SENDERS = {
    "emails": [
        "no-reply@shipping.amazon.es",
        "auto-confirm@amazon.es",
        "confirmar-envio@amazon.es",
        "order-update@amazon.es",
        "no-reply@amazon.es",
    ],
    "domains": ["amazon.es", "shipping.amazon.es"],
}

AMAZON_ORDER_PLACED_KEYWORDS = [
    "gracias por tu pedido",
    "pedido:",
]

AMAZON_SHIPPED_KEYWORDS = [
    "tu paquete se ha enviado",
    "pedido enviado",
]

NON_PACKAGE_KEYWORDS_ANY = [
    "euromillones",
    "loteria",
    "lottery",
    "boleto",
    "linkedin",
    "job alert",
    "job alerts",
    "vacante",
    "vacantes",
    "empleo",
    "canjea tus pasos",
    "antes de la medianoche",
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    raw = str(value).strip().lower()
    if raw in TRUE_VALUES:
        return True
    if raw in FALSE_VALUES:
        return False
    return default


def parse_int(value: Any, default: int) -> int:
    try:
        return int(str(value).strip())
    except Exception:
        return default


def log(level: str, event: str, **fields: Any) -> None:
    payload = {"ts": now_iso(), "level": level, "event": event, **fields}
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def strip_optional_quotes(value: str) -> str:
    v = value.strip()
    if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
        return v[1:-1]
    return v


def read_multiline_json_value(lines: list[str], start_idx: int, first_value: str) -> tuple[str, int]:
    candidate = first_value.strip()
    idx = start_idx
    while True:
        try:
            json.loads(candidate)
            return candidate, idx
        except Exception:
            if idx >= len(lines):
                return candidate, idx
            candidate = f"{candidate}\n{lines[idx]}"
            idx += 1


def load_dotenv_defaults(path: Path) -> None:
    if not path.exists():
        return

    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    idx = 0
    loaded = 0

    while idx < len(lines):
        raw_line = lines[idx]
        idx += 1
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in raw_line:
            continue

        key, value = raw_line.split("=", 1)
        key = key.strip()
        if not key:
            continue

        parsed_value = value.strip()
        if key == "IMAP_ACCOUNTS_JSON" and parsed_value and parsed_value[0] in ("[", "{"):
            parsed_value, idx = read_multiline_json_value(lines, idx, parsed_value)
        else:
            parsed_value = strip_optional_quotes(parsed_value)

        if key not in os.environ:
            os.environ[key] = parsed_value
            loaded += 1

    log("info", "dotenv_loaded", path=str(path), loaded=loaded)


def infer_provider(email_addr: str) -> str:
    email_addr = (email_addr or "").strip().lower()
    if "@" not in email_addr:
        return "generic"
    domain = email_addr.split("@", 1)[1]
    if "gmail.com" in domain or "googlemail.com" in domain:
        return "gmail"
    return "generic"


def normalize_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        raw = [value]
    elif isinstance(value, (list, tuple)):
        raw = list(value)
    else:
        return []
    out: list[str] = []
    for item in raw:
        s = str(item or "").strip().lower()
        if not s:
            continue
        out.append(s)
    return out


def first_email_domain(from_header: str) -> str:
    raw = str(from_header or "").strip().lower()
    if not raw:
        return ""
    # Try last email-like token first (<a@b.com> or a@b.com)
    emails = re.findall(r"[a-z0-9._%+\-]+@([a-z0-9.\-]+\.[a-z]{2,})", raw)
    if emails:
        return emails[-1]
    return ""


def first_email_address(from_header: str) -> str:
    raw = str(from_header or "").strip().lower()
    if not raw:
        return ""
    emails = re.findall(r"[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}", raw)
    if emails:
        return emails[-1]
    return ""


def official_carrier_from_sender(sender: str) -> str | None:
    sender_email = first_email_address(sender)
    sender_domain = first_email_domain(sender)
    if not sender_email and not sender_domain:
        return None

    for carrier, rules in OFFICIAL_CARRIER_SENDERS.items():
        emails = set(rules.get("emails") or [])
        domains = rules.get("domains") or []
        if sender_email and sender_email in emails:
            return carrier
        if sender_domain and any(
            sender_domain == domain or sender_domain.endswith(f".{domain}")
            for domain in domains
        ):
            return carrier
        if sender_domain and (
            re.fullmatch(r"dhl\.[a-z]{2,}", sender_domain)
            or re.fullmatch(r"dhl\.[a-z]{2,}\.[a-z]{2,}", sender_domain)
        ):
            return "DHL"

    return None


def official_amazon_sender(sender: str) -> bool:
    sender_email = first_email_address(sender)
    sender_domain = first_email_domain(sender)
    if sender_email and sender_email in set(OFFICIAL_AMAZON_SENDERS["emails"]):
        return True
    if sender_domain and any(
        sender_domain == domain or sender_domain.endswith(f".{domain}")
        for domain in OFFICIAL_AMAZON_SENDERS["domains"]
    ):
        return True
    return False


def extract_amazon_order_ids(subject: str, body: str, sender: str = "") -> list[str]:
    if not official_amazon_sender(sender):
        return []
    source = f"{subject}\n{body}".upper()
    return [normalize_tracking(match) for match in AMAZON_ORDER_ID_PATTERN.findall(source)]


def looks_package_like(sender: str, subject: str, body: str) -> bool:
    text = f"{sender}\n{subject}\n{body}".lower()
    if has_shipping_context(text):
        return True
    if official_amazon_sender(sender):
        if extract_amazon_order_ids(subject, body, sender=sender):
            return True
        if any(keyword in text for keyword in AMAZON_ORDER_PLACED_KEYWORDS + AMAZON_SHIPPED_KEYWORDS):
            return True
    if official_carrier_from_sender(sender):
        return True
    if guess_carrier(sender, subject, body):
        return True
    return False


def message_auth_flags(msg: Any) -> dict[str, bool]:
    auth_raw = str(msg.get("Authentication-Results") or "").lower()
    return {
        "dkim_pass": "dkim=pass" in auth_raw,
        "spf_pass": "spf=pass" in auth_raw,
        "dmarc_pass": "dmarc=pass" in auth_raw,
    }


def decode_mime_header(raw: Any) -> str:
    if not raw:
        return ""
    try:
        return str(make_header(decode_header(str(raw))))
    except Exception:
        return str(raw)


def resolve_sender_header(msg: Any) -> str:
    for header in (
        "From",
        "Sender",
        "Reply-To",
        "Return-Path",
        "Resent-From",
        "X-Original-From",
        "X-Forwarded-For",
        "Envelope-From",
    ):
        value = decode_mime_header(msg.get(header))
        if str(value or "").strip():
            return str(value).strip()
    return ""


def decode_bytes(raw: bytes | None, charset: str | None) -> str:
    if raw is None:
        return ""
    for candidate in [charset, "utf-8", "latin-1"]:
        if not candidate:
            continue
        try:
            return raw.decode(candidate, errors="replace")
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")


HTML_SCRIPT_RE = re.compile(r"<script.*?>.*?</script>", re.IGNORECASE | re.DOTALL)
HTML_STYLE_RE = re.compile(r"<style.*?>.*?</style>", re.IGNORECASE | re.DOTALL)
HTML_TAG_RE = re.compile(r"<[^>]+>")


def strip_html(text: str) -> str:
    cleaned = HTML_SCRIPT_RE.sub(" ", text)
    cleaned = HTML_STYLE_RE.sub(" ", cleaned)
    cleaned = HTML_TAG_RE.sub(" ", cleaned)
    cleaned = html.unescape(cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned)
    return cleaned.strip()


def parse_message_date(value: Any) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        dt = parsedate_to_datetime(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    except Exception:
        return None


def extract_message_text(msg: Any) -> str:
    plain_parts: list[str] = []
    html_parts: list[str] = []

    if msg.is_multipart():
        for part in msg.walk():
            content_type = str(part.get_content_type() or "").lower()
            disposition = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disposition:
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                raw = part.get_payload()
                if isinstance(raw, str):
                    if content_type == "text/html":
                        html_parts.append(strip_html(raw))
                    elif content_type == "text/plain":
                        plain_parts.append(raw)
                continue

            text = decode_bytes(payload, part.get_content_charset())
            if content_type == "text/plain":
                plain_parts.append(text)
            elif content_type == "text/html":
                html_parts.append(strip_html(text))
    else:
        content_type = str(msg.get_content_type() or "").lower()
        payload = msg.get_payload(decode=True)
        if payload is None and isinstance(msg.get_payload(), str):
            body = msg.get_payload()
        else:
            body = decode_bytes(payload, msg.get_content_charset())
        if content_type == "text/html":
            html_parts.append(strip_html(body))
        else:
            plain_parts.append(body)

    if plain_parts:
        text = "\n".join(plain_parts)
    else:
        text = "\n".join(html_parts)
    return re.sub(r"\s+", " ", text).strip()


def has_shipping_context(text: str) -> bool:
    lower = text.lower()
    return any(word in lower for word in SHIPPING_KEYWORDS)


def normalize_tracking(token: str) -> str:
    raw = token.strip().upper()
    raw = re.sub(r"\s+", "", raw)
    return raw.strip(".,;:()[]{}")


def looks_like_tracking_candidate(token: str) -> bool:
    if not token:
        return False
    if token in TRACKING_STOPWORDS:
        return False
    if len(token) < 8 or len(token) > 35:
        return False
    digits = sum(c.isdigit() for c in token)
    letters = sum(c.isalpha() for c in token)
    if digits < 3:
        return False
    if letters == 0 and len(token) < 10:
        return False
    if token.startswith("20") and token.isdigit() and len(token) == 8:
        return False
    return True


def looks_like_noise_weak_token(token: str) -> bool:
    compact = token.replace("-", "")
    if len(compact) >= 10 and re.fullmatch(r"[0-9A-F]+", compact):
        return True

    upper = token.upper()
    digits = sum(c.isdigit() for c in upper)
    letters = sum(c.isalpha() for c in upper)
    parts = [part for part in upper.split("-") if part]
    alpha_parts = sum(part.isalpha() for part in parts)

    # URL-encoded fragments and slug-like restaurant/menu paths were leaking
    # through the weak-token heuristic as fake trackings.
    if upper.startswith(("252F", "25252F", "2F", "HTTP", "WWW")):
        return True
    if upper.startswith("WEB-") and digits <= 7:
        return True
    if len(parts) >= 3 and alpha_parts >= 2 and digits <= 6:
        return True
    if letters >= max(8, digits * 2) and digits <= 6:
        return True
    if re.fullmatch(r"[A-Z]{2,4}[0-9]{6,8}", upper):
        return True

    return False


def extract_tracking_numbers(subject: str, body: str, sender: str = "") -> list[str]:
    source = f"{subject}\n{body}".upper()
    lower = source.lower()
    found: list[str] = []
    seen: set[str] = set()
    is_amazon_sender = official_amazon_sender(sender)

    def add_candidate(raw: str) -> None:
        tn = normalize_tracking(raw)
        if not looks_like_tracking_candidate(tn):
            return
        if tn in seen:
            return
        seen.add(tn)
        found.append(tn)

    for regex in TRACKING_STRONG_PATTERNS:
        for match in regex.findall(source):
            add_candidate(match)

    if is_amazon_sender:
        for match in extract_amazon_order_ids(subject, body, sender=sender):
            add_candidate(match)

    trusted_sender = official_carrier_from_sender(sender)
    if not is_amazon_sender and (trusted_sender or has_shipping_context(lower)):
        for match in TRACKING_WEAK_PATTERN.findall(source):
            if not trusted_sender and looks_like_noise_weak_token(normalize_tracking(match)):
                continue
            add_candidate(match)

    return found


def classify_status(subject: str, body: str, sender: str = "") -> tuple[str, str]:
    text = f"{subject}\n{body}".lower()
    if official_amazon_sender(sender):
        if any(word in text for word in DELIVERED_KEYWORDS):
            return "delivered", "Estado Amazon detectado por entrega"
        if any(word in text for word in OUT_FOR_DELIVERY_KEYWORDS):
            return "out_for_delivery", "Estado Amazon detectado por reparto"
        if any(word in text for word in AMAZON_SHIPPED_KEYWORDS):
            return "in_transit", "Estado Amazon detectado por envio"
        if extract_amazon_order_ids(subject, body, sender=sender) and any(word in text for word in AMAZON_ORDER_PLACED_KEYWORDS):
            return "info_received", "Estado Amazon detectado por confirmacion de pedido"

    is_delivered = any(word in text for word in DELIVERED_KEYWORDS)
    is_ofd = any(word in text for word in OUT_FOR_DELIVERY_KEYWORDS)
    if is_delivered and not is_ofd:
        return "delivered", "Estado detectado por keyword 'delivered/entregado'"
    if is_ofd:
        return "out_for_delivery", "Estado detectado por keyword 'out for delivery/en reparto'"
    if any(word in text for word in EXCEPTION_KEYWORDS):
        return "exception", "Estado detectado por incidencia/demora"
    if any(word in text for word in LABEL_KEYWORDS):
        return "info_received", "Estado detectado por preparacion de etiqueta/envio"
    return "in_transit", "Estado por defecto para email de seguimiento"


def guess_carrier(sender: str, subject: str, body: str) -> str | None:
    if official_amazon_sender(sender):
        return "Amazon"

    official_match = official_carrier_from_sender(sender)
    if official_match:
        return official_match

    sender_text = str(sender or "").lower()
    subject_text = str(subject or "").lower()
    body_text = str(body or "").lower()

    # Prefer sender and subject first. Looking through the full HTML body is too
    # noisy and was biasing many messages to "Correos" on generic footers.
    for hint, carrier in CARRIER_HINTS:
        if hint in sender_text or hint in subject_text:
            return carrier

    # Keep a softer body fallback for obvious carriers, but avoid "correos"
    # here because it is too easy to hit in unrelated content.
    for hint, carrier in CARRIER_HINTS:
        if hint == "correos":
            continue
        if hint in body_text:
            return carrier
    return None


def normalize_ignore_text(value: str) -> str:
    text = str(value or "").strip().lower()
    text = text.replace("á", "a").replace("é", "e").replace("í", "i").replace("ó", "o").replace("ú", "u")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def message_matches_ignore_rule(
    account: dict[str, Any],
    subject: str,
    body: str,
    ignore_rules: list[dict[str, Any]],
) -> tuple[bool, str]:
    if not ignore_rules:
        return False, "no_ignore_rules"

    account_email = str(account.get("email") or "").strip().lower()
    normalized_subject = normalize_ignore_text(subject)
    normalized_body = normalize_ignore_text(body)
    haystack = f"{normalized_subject}\n{normalized_body}"

    for rule in ignore_rules:
        if not isinstance(rule, dict):
            continue
        if rule.get("kind") != "subject_terms_all":
            continue
        if rule.get("active") is False:
            continue

        rule_account = str(rule.get("account_email") or "").strip().lower()
        if rule_account and rule_account != account_email:
            continue

        terms = [normalize_ignore_text(term) for term in rule.get("description_terms") or []]
        terms = [term for term in terms if term]
        if not terms:
            continue

        if all(term in haystack for term in terms):
            return True, str(rule.get("id") or "ignore_rule")

    return False, "ignore_rule_not_matched"


def looks_like_non_package_message(sender: str, subject: str, body: str) -> bool:
    text = f"{sender}\n{subject}\n{body}".lower()
    if has_shipping_context(text):
        return False
    if guess_carrier(sender, subject, body):
        return False
    return any(keyword in text for keyword in NON_PACKAGE_KEYWORDS_ANY)


def message_passes_filters(
    account: dict[str, Any],
    sender: str,
    subject: str,
    body: str,
    auth_flags: dict[str, bool],
) -> tuple[bool, str]:
    filters = account.get("filters") if isinstance(account.get("filters"), dict) else {}
    if not filters:
        return True, "no_filters"

    sender_domain = first_email_domain(sender)
    content = f"{subject}\n{body}".lower()

    allowed_domains = filters.get("allowed_sender_domains") or []
    if allowed_domains:
        ok = any(
            sender_domain == domain or sender_domain.endswith(f".{domain}")
            for domain in allowed_domains
        )
        if not ok:
            return False, "sender_domain_not_allowed"

    if filters.get("only_amazon"):
        amazon_sender = "amazon." in sender_domain
        amazon_content = "amazon" in content
        if not (amazon_sender or amazon_content):
            return False, "not_amazon_like"

    required_all = list(filters.get("required_keywords_all") or []) + list(filters.get("destination_keywords_all") or [])
    if required_all:
        missing = [word for word in required_all if word not in content]
        if missing:
            return False, f"missing_keywords_all:{','.join(missing[:3])}"

    required_any = filters.get("required_keywords_any") or []
    if required_any and not any(word in content for word in required_any):
        return False, "missing_keywords_any"

    reject_any = filters.get("reject_keywords_any") or []
    if reject_any and any(word in content for word in reject_any):
        return False, "matched_reject_keywords"

    if filters.get("require_dkim_pass") and not auth_flags.get("dkim_pass", False):
        return False, "dkim_not_pass"
    if filters.get("require_spf_pass") and not auth_flags.get("spf_pass", False):
        return False, "spf_not_pass"
    if filters.get("require_dmarc_pass") and not auth_flags.get("dmarc_pass", False):
        return False, "dmarc_not_pass"

    return True, "filters_pass"


def parse_uid_list(data: list[Any]) -> list[int]:
    chunks = [x for x in data if isinstance(x, (bytes, bytearray))]
    if not chunks:
        return []
    raw = b" ".join(chunks).decode("utf-8", errors="replace")
    out: list[int] = []
    for token in raw.split():
        if token.isdigit():
            out.append(int(token))
    return out


def login_imap(account: dict[str, Any], timeout_sec: int) -> imaplib.IMAP4_SSL:
    host = account["host"]
    port = account["port"]
    client = imaplib.IMAP4_SSL(host=host, port=port, timeout=timeout_sec)

    if account["auth"] == "password":
        client.login(account["username"], account["password"])
        return client

    raise RuntimeError(f"auth_not_supported:{account['auth']}")


def list_new_uids(
    client: imaplib.IMAP4_SSL,
    mailbox: str,
    last_uid: int,
    lookback_days: int,
) -> list[int]:
    status, _ = client.select(mailbox, readonly=True)
    if status != "OK":
        raise RuntimeError(f"imap_select_failed:{mailbox}")

    if last_uid <= 0 and lookback_days > 0:
        since = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime("%d-%b-%Y")
        status, data = client.uid("search", None, f"(SINCE {since})")
    else:
        status, data = client.uid("search", None, "ALL")

    if status != "OK":
        raise RuntimeError("imap_uid_search_failed")
    uids = parse_uid_list(data)
    if last_uid > 0:
        return [uid for uid in uids if uid > last_uid]
    return uids


def fetch_message(client: imaplib.IMAP4_SSL, uid: int) -> Any:
    status, data = client.uid("fetch", str(uid), "(RFC822)")
    if status != "OK":
        raise RuntimeError(f"imap_fetch_failed_uid:{uid}")

    raw_bytes = None
    for item in data:
        if isinstance(item, tuple) and len(item) >= 2 and isinstance(item[1], (bytes, bytearray)):
            raw_bytes = bytes(item[1])
            break

    if raw_bytes is None:
        raise RuntimeError(f"imap_fetch_empty_uid:{uid}")

    return BytesParser(policy=policy.default).parsebytes(raw_bytes)


def resolve_secret(raw_value: Any, env_key_name: Any) -> str:
    direct = str(raw_value or "").strip()
    if direct:
        return direct
    env_key = str(env_key_name or "").strip()
    if not env_key:
        return ""
    return str(os.getenv(env_key, "")).strip()


def temporary_account_block_for_email(email_addr: str, today: date | None = None) -> dict[str, Any] | None:
    rule = TEMPORARY_ACCOUNT_BLOCKS.get(str(email_addr or "").strip().lower())
    if not rule:
        return None

    current_date = today or datetime.now(timezone.utc).date()
    disabled_before = rule.get("disabled_before")
    if isinstance(disabled_before, date) and current_date < disabled_before:
        return rule
    return None


def account_block_for_email(email_addr: str, today: date | None = None) -> dict[str, Any] | None:
    normalized_email = str(email_addr or "").strip().lower()
    if not normalized_email:
        return None

    permanent_rule = PERMANENT_ACCOUNT_BLOCKS.get(normalized_email)
    if permanent_rule:
        return {
            "mode": "permanent",
            "disabled_until": permanent_rule.get("disabled_until"),
            "reason": permanent_rule.get("reason") or "disabled_by_code",
        }

    temporary_rule = temporary_account_block_for_email(normalized_email, today=today)
    if temporary_rule:
        return {
            "mode": "temporary",
            **temporary_rule,
        }

    return None


def normalize_account(raw: Any, default_owner: str) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError("account_not_object")

    email_addr = str(raw.get("email") or "").strip().lower()
    if not email_addr or "@" not in email_addr:
        raise ValueError("email_missing_or_invalid")

    provider = str(raw.get("provider") or infer_provider(email_addr)).strip().lower()
    enabled = parse_bool(raw.get("enabled"), default=True)
    owner = str(raw.get("owner") or default_owner or "").strip().lower()
    if not owner and enabled:
        raise ValueError("owner_missing")
    if not owner:
        owner = "_disabled"
    if provider == "outlook" or "hotmail." in email_addr or "outlook." in email_addr or "live." in email_addr:
        raise ValueError("provider_not_supported:outlook")
    host = str(raw.get("host") or "").strip()
    if not host:
        if provider == "gmail":
            host = "imap.gmail.com"
        else:
            raise ValueError("host_missing_for_generic_provider")

    port = parse_int(raw.get("port"), 993)
    username = str(raw.get("username") or email_addr).strip()
    mailbox = str(raw.get("mailbox") or "INBOX").strip()
    auth = str(raw.get("auth") or "").strip().lower()
    if not auth:
        auth = "password"
    filters_raw = raw.get("filters") if isinstance(raw.get("filters"), dict) else {}
    filters = {
        "only_amazon": parse_bool(filters_raw.get("only_amazon"), default=False),
        "allowed_sender_domains": normalize_string_list(filters_raw.get("allowed_sender_domains")),
        "required_keywords_all": normalize_string_list(filters_raw.get("required_keywords_all")),
        "required_keywords_any": normalize_string_list(filters_raw.get("required_keywords_any")),
        "reject_keywords_any": normalize_string_list(filters_raw.get("reject_keywords_any")),
        "destination_keywords_all": normalize_string_list(filters_raw.get("destination_keywords_all")),
        "require_dkim_pass": parse_bool(filters_raw.get("require_dkim_pass"), default=False),
        "require_spf_pass": parse_bool(filters_raw.get("require_spf_pass"), default=False),
        "require_dmarc_pass": parse_bool(filters_raw.get("require_dmarc_pass"), default=False),
    }

    out: dict[str, Any] = {
        "email": email_addr,
        "owner": owner,
        "provider": provider,
        "enabled": enabled,
        "host": host,
        "port": port,
        "username": username,
        "mailbox": mailbox,
        "auth": auth,
        "filters": filters,
    }

    if not enabled:
        return out

    if auth == "password":
        password = resolve_secret(
            raw.get("password") or raw.get("app_password"),
            raw.get("password_env") or raw.get("app_password_env"),
        )
        if not password:
            raise ValueError("password_missing")
        out["password"] = password
    else:
        raise ValueError(f"auth_not_supported:{auth}")

    return out


def load_accounts() -> list[dict[str, Any]]:
    raw = str(os.getenv("IMAP_ACCOUNTS_JSON") or "").strip()
    if not raw:
        file_path = str(os.getenv("IMAP_ACCOUNTS_FILE") or "").strip()
        if file_path:
            raw = Path(file_path).read_text(encoding="utf-8", errors="replace").strip()
    if not raw:
        raise RuntimeError("IMAP_ACCOUNTS_JSON is required")

    parsed = json.loads(raw)
    if not isinstance(parsed, list):
        raise RuntimeError("IMAP_ACCOUNTS_JSON must be a JSON array")

    default_owner = str(os.getenv("IMAP_DEFAULT_OWNER") or "unnamed").strip().lower()
    out: list[dict[str, Any]] = []
    for idx, account in enumerate(parsed):
        try:
            normalized = normalize_account(account, default_owner=default_owner)
            if normalized["enabled"]:
                block = account_block_for_email(normalized["email"])
                if block:
                    log(
                        "info",
                        "imap_account_skipped_disabled_by_code" if block.get("mode") == "permanent" else "imap_account_skipped_temporarily_disabled",
                        idx=idx,
                        email=normalized["email"],
                        disabled_until=block.get("disabled_until"),
                        reason=block.get("reason"),
                    )
                    continue
                out.append(normalized)
            else:
                log("info", "imap_account_skipped_disabled", idx=idx, email=normalized["email"])
        except Exception as exc:
            error_text = str(exc)
            if error_text.startswith("provider_not_supported:") or error_text.startswith("auth_not_supported:oauth2"):
                email = str(account.get("email") or "").strip().lower() if isinstance(account, dict) else ""
                log("warn", "imap_account_skipped_unsupported", idx=idx, email=email, error=error_text)
                continue
            raise RuntimeError(f"Invalid account at index {idx}: {exc}") from exc
    return out


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"accounts": {}}
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {"accounts": {}}
    if not isinstance(parsed, dict):
        return {"accounts": {}}
    accounts = parsed.get("accounts")
    if not isinstance(accounts, dict):
        parsed["accounts"] = {}
    return parsed


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp_path, path)


def account_state_key(account: dict[str, Any]) -> str:
    return f"{account['owner']}|{account['email']}|{account['mailbox']}"


def dedupe_items(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[Any, ...]] = set()
    out: list[dict[str, Any]] = []
    for item in items:
        key = (
            item.get("tracking"),
            item.get("account_email"),
            item.get("time_iso"),
            item.get("status"),
            item.get("description"),
        )
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def process_account(
    account: dict[str, Any],
    last_uid: int,
    lookback_days: int,
    fetch_limit: int,
    timeout_sec: int,
    ignore_rules: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], int, int, int, dict[str, int], dict[str, list[dict[str, str | None]]]]:
    client: imaplib.IMAP4_SSL | None = None
    max_seen_uid = last_uid
    scanned = 0
    filtered_out = 0
    filtered_reasons: dict[str, int] = {}
    filtered_samples: dict[str, list[dict[str, str | None]]] = {}
    items: list[dict[str, Any]] = []

    def add_filtered_sample(reason: str, sender: str, subject: str) -> None:
        bucket = filtered_samples.setdefault(reason, [])
        if len(bucket) >= 3:
            return
        bucket.append(
            {
                "sender": str(sender or "").strip()[:160] or None,
                "subject": str(subject or "").strip()[:180] or None,
            }
        )

    try:
        client = login_imap(account, timeout_sec=timeout_sec)
        uids = list_new_uids(client, account["mailbox"], last_uid=last_uid, lookback_days=lookback_days)
        if fetch_limit > 0 and len(uids) > fetch_limit:
            uids = uids[-fetch_limit:]

        for uid in uids:
            scanned += 1
            max_seen_uid = max(max_seen_uid, uid)
            msg = fetch_message(client, uid=uid)
            subject = decode_mime_header(msg.get("Subject"))
            sender = resolve_sender_header(msg)
            date_iso = parse_message_date(msg.get("Date"))
            body = extract_message_text(msg)
            auth_flags = message_auth_flags(msg)
            accepted, reason = message_passes_filters(
                account=account,
                sender=sender,
                subject=subject,
                body=body,
                auth_flags=auth_flags,
            )
            if not accepted:
                filtered_out += 1
                filtered_reasons[reason] = filtered_reasons.get(reason, 0) + 1
                add_filtered_sample(reason, sender, subject)
                continue

            ignored, ignore_reason = message_matches_ignore_rule(
                account=account,
                subject=subject,
                body=body,
                ignore_rules=ignore_rules,
            )
            if ignored:
                filtered_out += 1
                reason_key = f"matched_ignore_rule:{ignore_reason}"
                filtered_reasons[reason_key] = filtered_reasons.get(reason_key, 0) + 1
                add_filtered_sample(reason_key, sender, subject)
                continue

            if looks_like_non_package_message(sender=sender, subject=subject, body=body):
                filtered_out += 1
                filtered_reasons["non_package_signature"] = filtered_reasons.get("non_package_signature", 0) + 1
                add_filtered_sample("non_package_signature", sender, subject)
                continue

            trackings = extract_tracking_numbers(subject=subject, body=body, sender=sender)
            if not trackings:
                if looks_package_like(sender=sender, subject=subject, body=body):
                    filtered_out += 1
                    filtered_reasons["package_like_but_no_tracking"] = filtered_reasons.get("package_like_but_no_tracking", 0) + 1
                    add_filtered_sample("package_like_but_no_tracking", sender, subject)
                continue

            status, status_note = classify_status(subject=subject, body=body, sender=sender)
            description = subject.strip()[:180] if subject.strip() else status_note
            carrier_name = guess_carrier(sender=sender, subject=subject, body=body)
            if len(trackings) > 1 or not sender.strip() or not carrier_name:
                log(
                    "warn",
                    "imap_message_suspicious_candidates",
                    owner=account["owner"],
                    email=account["email"],
                    uid=uid,
                    sender=str(sender or "").strip() or None,
                    subject=str(subject or "").strip()[:180] or None,
                    trackings=trackings[:12],
                    trackings_total=len(trackings),
                    shipping_context=has_shipping_context(f"{subject}\n{body}"),
                    trusted_sender=bool(official_amazon_sender(sender) or official_carrier_from_sender(sender)),
                    carrier_name=carrier_name,
                )

            for tracking in trackings:
                item = {
                    "tracking": tracking,
                    "status": status,
                    "description": description,
                    "time_iso": date_iso,
                    "account_email": account["email"],
                    "subject": subject,
                    "sender": sender,
                }
                if carrier_name:
                    item["carrier_name"] = carrier_name
                items.append(item)
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass
            try:
                client.logout()
            except Exception:
                pass

    return dedupe_items(items), max_seen_uid, scanned, filtered_out, filtered_reasons, filtered_samples


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    if size <= 0:
        return [items]
    return [items[i : i + size] for i in range(0, len(items), size)]


def post_ingest(
    base_url: str,
    owner: str,
    items: list[dict[str, Any]],
    api_key: str,
    timeout_sec: int,
) -> dict[str, Any]:
    endpoint = f"{base_url.rstrip('/')}/api/owner/{quote(owner, safe='')}/imap/ingest"
    payload = json.dumps({"items": items}, ensure_ascii=False).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    req = Request(endpoint, data=payload, headers=headers, method="POST")
    with urlopen(req, timeout=timeout_sec) as res:
        body = res.read()
        status_code = res.status

    if status_code < 200 or status_code >= 300:
        raise RuntimeError(f"ingest_http_{status_code}")

    if not body:
        return {}
    return json.loads(body.decode("utf-8", errors="replace"))


def fetch_ignore_rules(base_url: str, owner: str, api_key: str, timeout_sec: int) -> list[dict[str, Any]]:
    endpoint = f"{base_url.rstrip('/')}/api/owner/{quote(owner, safe='')}/imap/ignore_rules"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    req = Request(endpoint, headers=headers, method="GET")
    with urlopen(req, timeout=max(1, min(timeout_sec, DEFAULT_IGNORE_RULES_TIMEOUT_SEC))) as res:
        body = res.read()
        status_code = res.status

    if status_code < 200 or status_code >= 300 or not body:
        return []

    payload = json.loads(body.decode("utf-8", errors="replace"))
    rules = payload.get("rules")
    return rules if isinstance(rules, list) else []


def post_account_binding(
    base_url: str,
    owner: str,
    account: dict[str, Any],
    api_key: str,
    timeout_sec: int,
) -> dict[str, Any]:
    endpoint = f"{base_url.rstrip('/')}/api/owner/{quote(owner, safe='')}/imap/accounts"
    payload = json.dumps(
        {
            "email": account["email"],
            "provider": account["provider"],
            "enabled": True,
        },
        ensure_ascii=False,
    ).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["X-API-Key"] = api_key

    req = Request(endpoint, data=payload, headers=headers, method="POST")
    with urlopen(req, timeout=timeout_sec) as res:
        body = res.read()
        status_code = res.status

    if status_code < 200 or status_code >= 300:
        raise RuntimeError(f"account_binding_http_{status_code}")

    if not body:
        return {}
    return json.loads(body.decode("utf-8", errors="replace"))


def main() -> int:
    load_dotenv_defaults(Path(str(os.getenv("IMAP_WORKER_DOTENV_PATH") or DEFAULT_DOTENV_PATH)))

    base_url = str(os.getenv("IMAP_INGEST_BASE_URL") or DEFAULT_BASE_URL).strip()
    api_key = str(os.getenv("IMAP_INGEST_API_KEY") or os.getenv("APP_API_KEY") or "").strip()
    dry_run = parse_bool(os.getenv("IMAP_WORKER_DRY_RUN"), default=False)
    lookback_days = parse_int(os.getenv("IMAP_WORKER_LOOKBACK_DAYS"), DEFAULT_LOOKBACK_DAYS)
    fetch_limit = parse_int(os.getenv("IMAP_WORKER_FETCH_LIMIT"), DEFAULT_FETCH_LIMIT)
    batch_size = parse_int(os.getenv("IMAP_INGEST_BATCH_SIZE"), DEFAULT_BATCH_SIZE)
    timeout_sec = parse_int(os.getenv("IMAP_INGEST_TIMEOUT_SEC"), DEFAULT_TIMEOUT_SEC)
    state_path = Path(str(os.getenv("IMAP_WORKER_STATE_PATH") or DEFAULT_STATE_PATH))

    try:
        accounts = load_accounts()
    except Exception as exc:
        log("error", "imap_worker_config_invalid", error=str(exc))
        return 2

    if not accounts:
        log("warn", "imap_worker_no_accounts_enabled")
        return 0

    state = load_state(state_path)
    state_accounts = state.setdefault("accounts", {})

    had_errors = False
    items_by_owner: dict[str, list[dict[str, Any]]] = {}
    ignore_rules_by_owner: dict[str, list[dict[str, Any]]] = {}
    pending_updates: dict[str, dict[str, Any]] = {}
    failed_post_owners: set[str] = set()
    failed_accounts = 0

    log(
        "info",
        "imap_worker_start",
        accounts=len(accounts),
        base_url=base_url,
        dry_run=dry_run,
        state_path=str(state_path),
    )

    for account in accounts:
        key = account_state_key(account)
        old_state = state_accounts.get(key) if isinstance(state_accounts.get(key), dict) else {}
        last_uid = parse_int(old_state.get("last_uid"), 0)

        try:
            try:
                account_binding_response = post_account_binding(
                    base_url=base_url,
                    owner=account["owner"],
                    account=account,
                    api_key=api_key,
                    timeout_sec=timeout_sec,
                )
                reconciliation = account_binding_response.get("reconciliation") if isinstance(account_binding_response, dict) else None
                if isinstance(reconciliation, dict) and (
                    parse_int(reconciliation.get("removed_trackings"), 0) > 0
                    or (isinstance(reconciliation.get("owners"), list) and reconciliation.get("owners"))
                ):
                    log(
                        "warn",
                        "imap_account_binding_reconciled",
                        owner=account["owner"],
                        email=account["email"],
                        reconciliation=reconciliation,
                    )
            except Exception as exc:
                log(
                    "warn",
                    "imap_account_binding_failed",
                    owner=account["owner"],
                    email=account["email"],
                    error=str(exc),
                )

            owner_ignore_rules = ignore_rules_by_owner.get(account["owner"])
            if owner_ignore_rules is None:
                try:
                    owner_ignore_rules = fetch_ignore_rules(
                        base_url=base_url,
                        owner=account["owner"],
                        api_key=api_key,
                        timeout_sec=timeout_sec,
                    )
                except Exception as exc:
                    owner_ignore_rules = []
                    log(
                        "warn",
                        "imap_ignore_rules_fetch_failed",
                        owner=account["owner"],
                        error=str(exc),
                    )
                ignore_rules_by_owner[account["owner"]] = owner_ignore_rules

            items, max_uid, scanned, filtered_out, filtered_reasons, filtered_samples = process_account(
                account=account,
                last_uid=last_uid,
                lookback_days=lookback_days,
                fetch_limit=fetch_limit,
                timeout_sec=timeout_sec,
                ignore_rules=owner_ignore_rules,
            )
            pending_updates[key] = {
                "owner": account["owner"],
                "state": {
                    "last_uid": max_uid,
                    "updated_at": now_iso(),
                    "last_scan_count": scanned,
                    "last_item_count": len(items),
                    "last_filtered_count": filtered_out,
                    # Persist filter reason counters to debug false positives/noise per account.
                    "last_filtered_reasons": filtered_reasons,
                    "last_filtered_samples": filtered_samples,
                    "provider": account["provider"],
                    "mailbox": account["mailbox"],
                },
            }
            if items:
                owner_items = items_by_owner.setdefault(account["owner"], [])
                owner_items.extend(items)

            log(
                "info",
                "imap_account_processed",
                owner=account["owner"],
                email=account["email"],
                provider=account["provider"],
                scanned=scanned,
                filtered=filtered_out,
                filtered_reasons=filtered_reasons,
                filtered_samples=filtered_samples,
                extracted=len(items),
                last_uid_before=last_uid,
                last_uid_after=max_uid,
            )
        except Exception as exc:
            had_errors = True
            failed_accounts += 1
            log(
                "error",
                "imap_account_failed",
                owner=account["owner"],
                email=account["email"],
                provider=account["provider"],
                error=str(exc),
                traceback=traceback.format_exc(limit=1).strip(),
            )

    posted_items = 0
    if dry_run:
        for owner, items in items_by_owner.items():
            log("info", "imap_ingest_dry_run_owner", owner=owner, items=len(items))
    else:
        for owner, items in items_by_owner.items():
            unique_items = dedupe_items(items)
            try:
                for batch in chunked(unique_items, batch_size):
                    response = post_ingest(
                        base_url=base_url,
                        owner=owner,
                        items=batch,
                        api_key=api_key,
                        timeout_sec=timeout_sec,
                    )
                    posted_items += len(batch)
                    log(
                        "info",
                        "imap_ingest_posted_batch",
                        owner=owner,
                        batch_size=len(batch),
                        ingested=response.get("ingested"),
                        skipped_invalid=response.get("skipped_invalid"),
                    )
            except HTTPError as exc:
                had_errors = True
                failed_post_owners.add(owner)
                body = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
                log("error", "imap_ingest_http_error", owner=owner, status=exc.code, body=body[:500])
            except URLError as exc:
                had_errors = True
                failed_post_owners.add(owner)
                log("error", "imap_ingest_network_error", owner=owner, reason=str(exc.reason))
            except Exception as exc:
                had_errors = True
                failed_post_owners.add(owner)
                log("error", "imap_ingest_post_failed", owner=owner, error=str(exc))

    applied = 0
    skipped = 0
    for key, payload in pending_updates.items():
        owner = payload["owner"]
        if owner in failed_post_owners:
            skipped += 1
            continue
        state_accounts[key] = payload["state"]
        applied += 1

    try:
        save_state(state_path, state)
    except Exception as exc:
        had_errors = True
        log("error", "imap_state_save_failed", path=str(state_path), error=str(exc))
        return 1

    log(
        "info",
        "imap_worker_done",
        owners=len(items_by_owner),
        posted_items=posted_items,
        state_updates_applied=applied,
        state_updates_skipped=skipped,
        failed_accounts=failed_accounts,
        failed_post_owners=len(failed_post_owners),
        had_errors=had_errors,
    )

    return 0


if __name__ == "__main__":
    sys.exit(main())
