# Hiring.Cafe Search State Reference

The `hiringcafe.search_state` object in `config.json` maps directly to Hiring.Cafe's `?searchState=` query parameter. These fields are managed in `config.json` only (no UI).

## Current settings

| Field | Value | Notes |
|---|---|---|
| `jobTitleQuery` | `"software engineer", software` | Quoted phrase + broad keyword |
| `seniorityLevel` | `["Entry Level", "No Prior Experience Required"]` | Both entry-level tiers |
| `bachelorsDegreeRequirements` | `["Required"]` | Only jobs requiring a BS |
| `mastersDegreeRequirements` | `["Not Mentioned"]` | Excludes jobs mentioning MS/PhD |
| `bachelorsDegreeFieldsOfStudy` | `["computer science"]` | CS degrees only |
| `maxCompensationLowEnd` | `"80000"` | Low end of salary band <= $80K |
| `securityClearances` | `["None"]` | No clearance needed |
| `restrictJobsToTransparentSalaries` | `true` | Only jobs with visible salary |
| `dateFetchedPastNDays` | Set by `days_old` config | Rolling window |
| `locations` | US-wide with flexible regions | Country-level search |

## How to update

1. Go to [hiring.cafe](https://hiring.cafe) and configure your search via the UI
2. Copy the `searchState` JSON from the URL bar
3. Paste it into `config.json` under `hiringcafe.search_state`
4. The `dateFetchedPastNDays` field is overridden at scrape time by `hiringcafe.days_old`
