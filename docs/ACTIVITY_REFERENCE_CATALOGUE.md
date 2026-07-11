# Activity Reference Catalogue

## Purpose

`backend/data/SECRETARY_ACTIVITIES_CATALOGUE.csv` is a read-only multi-industry reference catalogue supplied by the project owner. It helps a user find a candidate activity; it is not evidence that a particular company performs every listed activity.

The current source contains:

- 1,817 CSV rows;
- 1,810 unique `activity_code` values;
- 7 exact duplicate rows, deterministically deduplicated by `activity_code`;
- 14 industries and 168 subtypes;
- complete values in all ten required columns.

If the same `activity_code` ever appears with conflicting row content, loading fails closed instead of choosing one version.

## Truth and pricing rules

- Browsing the reference catalogue never changes company data.
- One activity becomes a company service only through the risk-3 `activate_reference_activity` confirmation flow.
- Confirmation explicitly asserts that the company really performs that activity.
- Activation creates or confirms the matching company Industry and links it to the new Service Catalogue item.
- The Oxfordshire rate is retained as `referenceRateGbp` provenance only.
- Reference rates are never copied into `basePriceMin`, `basePriceMax` or `priceUnit` automatically.
- Company pricing, description, duration and required skills remain unknown unless explicitly entered by the user.

## API

| Method | Path | Permission | Behaviour |
|---|---|---|---|
| `GET` | `/service-catalogue/reference-activities` | `crm.read` | Search/filter the deduplicated reference catalogue with pagination and source diagnostics. |
| `POST` | `/service-catalogue/reference-activities/:activityCode/activate` | `crm.manage` | First returns a confirmation preview; `confirmed: true` creates the company service, industry and link atomically. |

The list endpoint accepts `search`, `industry_code`, `subtype_code`, `offset` and `limit` (maximum 100). The activation payload can optionally contain explicit company values: `description`, `base_price_min`, `base_price_max`, `price_unit`, `default_duration_hours` and `default_required_skills`.

The unique database key `(companyId, referenceActivityCode)` prevents a company from activating the same reference activity twice. Different companies remain isolated and can confirm their own activity sets independently.
