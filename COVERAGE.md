# Data Coverage

This document describes what data the Czech Competition MCP contains and its known limitations.

## Sources

| Source | Authority | URL | Scope |
|--------|-----------|-----|-------|
| UOHS Enforcement Decisions | Úřad pro ochranu hospodářské soutěže (UOHS) | https://www.uohs.cz/cs/hospodarska-soutez/spravni-rozhodnuti.html | Abuse of dominance, cartel, public procurement, sector inquiries |
| UOHS Merger Control Decisions | Úřad pro ochranu hospodářské soutěže (UOHS) | https://www.uohs.cz/cs/hospodarska-soutez/spojovani-soutezitelu.html | Merger control under ZOHS §12-19 |

## Decision Types Covered

| Type | Czech Term | ZOHS Basis |
|------|------------|------------|
| `abuse_of_dominance` | Zneužití dominantního postavení | §10-11 ZOHS |
| `cartel` | Kartelové dohody | §3-6 ZOHS |
| `public_procurement` | Veřejné zakázky | §19b ZOHS |
| `sector_inquiry` | Šetření trhu | §21b ZOHS |

## Merger Outcomes

| Outcome | Meaning |
|---------|---------|
| `cleared` | Unconditional clearance |
| `cleared_with_conditions` | Cleared subject to remedies/conditions |
| `blocked` | Prohibited by UOHS |
| `withdrawn` | Notifying party withdrew notification |

## Decision Outcomes

| Outcome | Meaning |
|---------|---------|
| `infringement` | Competition law infringement found |
| `commitment` | Case closed with binding commitments |
| `no_infringement` | No infringement found |
| `fine` | Monetary penalty imposed |

## Known Limitations

- Coverage is limited to decisions published on the UOHS website; unpublished or confidential decisions are not included.
- Full decision text may be truncated for very long documents.
- Data currency depends on the ingestion schedule — always verify against UOHS primary sources for compliance purposes.
- Czech-language content is prioritised; some older decisions may have limited English metadata.

## Freshness

Use `cz_comp_check_data_freshness` to query the latest decision and merger dates in the database.
