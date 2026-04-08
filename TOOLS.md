# Tool Reference

All tools use the prefix `cz_comp_`. There are 8 tools in total.

## Search and Retrieval

### `cz_comp_search_decisions`

Full-text search across UOHS competition enforcement decisions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (Czech or English, e.g., `'dominantní postavení'`, `'kartel'`, `'veřejná zakázka'`) |
| `type` | enum | No | Filter by case type: `abuse_of_dominance`, `cartel`, `sector_inquiry`, `public_procurement` |
| `sector` | string | No | Filter by industry sector (e.g., `'energy'`, `'telecommunications'`) |
| `outcome` | enum | No | Filter by outcome: `infringement`, `commitment`, `no_infringement`, `fine` |
| `limit` | number | No | Maximum results (default 20, max 100) |

**Returns:** Array of decisions with `case_number`, `title`, `date`, `type`, `sector`, `parties`, `summary`, `outcome`, `fine_amount`, `competition_articles`.

---

### `cz_comp_get_decision`

Get a specific UOHS decision by case number.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | Yes | UOHS case number (e.g., `'UOHS-S0001/2024/KD'`, `'UOHS-R0050/2023/HS'`) |

**Returns:** Full decision record including `full_text`.

---

### `cz_comp_search_mergers`

Search UOHS merger control decisions.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query (e.g., `'spojení soutěžitelů'`, `'retail'`, `'energie'`) |
| `sector` | string | No | Filter by industry sector |
| `outcome` | enum | No | Filter by outcome: `cleared`, `cleared_with_conditions`, `blocked`, `withdrawn` |
| `limit` | number | No | Maximum results (default 20, max 100) |

**Returns:** Array of merger cases with `case_number`, `title`, `date`, `sector`, `acquiring_party`, `target`, `summary`, `outcome`, `turnover`.

---

### `cz_comp_get_merger`

Get a specific UOHS merger control decision by case number.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `case_number` | string | Yes | UOHS merger case number (e.g., `'UOHS-S0010/2024/KS'`) |

**Returns:** Full merger record including `full_text`.

---

## Browse

### `cz_comp_list_sectors`

List all industry sectors with UOHS enforcement activity.

**Parameters:** None

**Returns:** Array of sectors with `id`, `name`, `name_en`, `description`, `decision_count`, `merger_count`.

---

## Meta

### `cz_comp_about`

Return server metadata.

**Parameters:** None

**Returns:** `name`, `version`, `description`, `data_source`, `coverage`, `tools`.

---

### `cz_comp_list_sources`

List authoritative data sources with provenance metadata.

**Parameters:** None

**Returns:** Array of sources with `id`, `name`, `authority`, `url`, `scope`, `license`, `update_frequency`.

---

### `cz_comp_check_data_freshness`

Check data currency and record counts.

**Parameters:** None

**Returns:** `decisions_latest_date`, `mergers_latest_date`, `decisions_count`, `mergers_count`, `checked_at`.
