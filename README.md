# VG Azure DevOps Reporter — Node Utility

Admin report utility for Vision Group Azure DevOps projects.  
Generates polished HTML reports directly from your ADO org via REST API.

---

## Setup

**Requirements:** Node.js 16+ (no npm install needed — zero dependencies)

```bash
# 1. Place this folder anywhere on your machine, e.g.:
#    C:\Users\YourName\Downloads\ado-reporter\

# 2. Run it
node index.js
```

On first run, you will be prompted for:
- **Azure DevOps Org URL** — e.g. `https://dev.azure.com/visiongroupretail`
- **Project name** — e.g. `VG-Platform`
- **Personal Access Token (PAT)** — generate one at:
  `https://dev.azure.com/{yourorg}/_usersSettings/tokens`
  Required scopes: `Work Items (Read)`

Your config is saved locally in `.config.json` for next time.

---

## Available Reports

| # | Report | What it shows |
|---|--------|---------------|
| 1 | **Estimate Pending Stories** | All stories blocked on estimation, grouped by reason |
| 2 | **QA Bandwidth Risk** | Work remaining vs QA capacity over 20 work days |
| 3 | **Active Bugs by Severity** | Open bugs grouped by severity (Critical → Low) |
| 4 | **Sprint Work by Assignee** | Items distributed across team members |
| 5 | **Stories by Platform** | Grouped by Mobile / Cloud / Portal / Parquet |
| 6 | **Stories by Client** | Grouped by Henkel, ARCA BU, All, etc. |
| 7 | **Critical & High Priority** | Severity 1 & 2 items only |
| 8 | **Full Work Item Dump** | All active items with all fields |

---

## Output

Reports are saved as self-contained HTML files in the `reports/` folder  
and automatically open in your default browser.

Features of every report:
- Live search / filter bar
- Severity colour badges (Critical / High / Medium / Low)
- State badges (Estimate Pending / Active / New)
- QA risk capacity bar with overshoot indicator
- Action items table for management

---

## Customisation

Edit `ado-client.js` to:
- Change `QA_CAPACITY_PER_DAY` and `QA_TEAM_SIZE` in the `renderQaRisk` function
- Add custom WIQL queries in the `QUERIES` object
- Add new field mappings in `f()` for your custom ADO fields

---

## PAT Token

Generate at: `https://dev.azure.com/{yourorg}/_usersSettings/tokens`

Minimum scopes needed:
- ✅ Work Items — **Read**

Do NOT commit `.config.json` to source control (it contains your PAT).

---

*VG — Vision Group Internal Tool*
