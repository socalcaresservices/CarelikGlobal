# OGV-DATA-001 Appendix A: Table dictionary

Part of [OGV-DATA-001](OGV-DATA-001-database-and-data-dictionary.md) (draft v0.1, inspection date 2026-10-11, commit `f0f1405`, schema as produced by migrations `0001` to `0048`). 62 tables, 690 columns. Types are PostgreSQL types; `ogevia.` schema prefixes are omitted. 'Null' is the column's nullability. Lifecycle and sensitivity are explained in section 8 of the master document.

Generated from the PostgreSQL catalogs of a local build of the 48 repository migrations (PostgreSQL 16.15); see the master document's method and limitations. Production's recorded level is `46|0046`, so objects added by `0047` and `0048` are not in production. Sensitivity labels are the author's analysis, not a compliance determination.

## Identity and tenancy

### `organizations`

The tenant (agency). Name, slug, status, time zone, branding and business contact data.

- **Domain:** Identity and tenancy · **Introduced:** migration 0002 · **Tenant key:** tenant root
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Business contact data (organization); no personal data of clients

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `slug` | text | NO |  |
| 3 | `display_name` | text | NO |  |
| 4 | `status` | organization_status | NO | `'active'::organization_status` |
| 5 | `timezone` | text | NO | `'America/Los_Angeles'::text` |
| 6 | `created_at` | timestamptz | NO | `now()` |
| 7 | `updated_at` | timestamptz | NO | `now()` |
| 8 | `accent_color` | text | yes |  |
| 9 | `logo_object_key` | text | yes |  |
| 10 | `logo_s3_version_id` | text | yes |  |
| 11 | `logo_content_type` | text | yes |  |
| 12 | `logo_sha256` | text | yes |  |
| 13 | `logo_updated_at` | timestamptz | yes |  |
| 14 | `document_reminder_days` | integer[] | NO | `'{90,60,30,14,7}'::integer[]` |
| 15 | `legal_name` | text | yes |  |
| 16 | `address_street` | text | yes |  |
| 17 | `address_city` | text | yes |  |
| 18 | `address_state` | text | yes |  |
| 19 | `address_zip` | text | yes |  |
| 20 | `contact_phone` | text | yes |  |
| 21 | `contact_email` | text | yes |  |

**Primary key**

- `organizations_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `organizations_slug_key`: `UNIQUE (slug)`

**Check (12)**

- `organizations_accent_color_check`: `CHECK (((accent_color IS NULL) OR (accent_color ~ '^#[0-9a-f]{6}$'::text)))`
- `organizations_address_city_check`: `CHECK (((address_city IS NULL) OR ((length(address_city) >= 2) AND (length(address_city) <= 80))))`
- `organizations_address_state_check`: `CHECK (((address_state IS NULL) OR (address_state ~ '^[A-Z]{2}$'::text)))`
- `organizations_address_street_check`: `CHECK (((address_street IS NULL) OR ((length(address_street) >= 2) AND (length(address_street) <= 120))))`
- `organizations_address_zip_check`: `CHECK (((address_zip IS NULL) OR (address_zip ~ '^[0-9]{5}(-[0-9]{4})?$'::text)))`
- `organizations_contact_email_check`: `CHECK (((contact_email IS NULL) OR ((length(contact_email) <= 254) AND (contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'::text))))`
- `organizations_contact_phone_check`: `CHECK (((contact_phone IS NULL) OR (((length(contact_phone) >= 7) AND (length(contact_phone) <= 25)) AND (contact_phone ~ '^[0-9+(). -]+$'::text))))`
- `organizations_document_reminder_days_valid`: `CHECK (COALESCE(valid_reminder_days(document_reminder_days), false))`
- `organizations_legal_name_check`: `CHECK (((legal_name IS NULL) OR ((length(legal_name) >= 2) AND (length(legal_name) <= 120))))`
- `organizations_logo_content_type_check`: `CHECK (((logo_content_type IS NULL) OR (logo_content_type = ANY (ARRAY['image/png'::text, 'image/jpeg'::text]))))`
- `organizations_logo_sha256_check`: `CHECK (((logo_sha256 IS NULL) OR (logo_sha256 ~ '^[0-9a-f]{64}$'::text)))`
- `organizations_slug_check`: `CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'::text))`

**Indexes (1 besides the primary key)**

- `organizations_slug_key`: `UNIQUE btree (slug)`

### `app_users`

One row per signed-in person, keyed by the Cognito `sub`; status gates `begin_request`. No email or password is stored here.

- **Domain:** Identity and tenancy · **Introduced:** migration 0002 · **Tenant key:** none (global/identity table)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce identity: display name; Cognito `sub` (identifier)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `cognito_sub` | text | yes |  |
| 3 | `display_name` | text | yes |  |
| 4 | `status` | text | NO | `'active'::text` |
| 5 | `created_at` | timestamptz | NO | `now()` |
| 6 | `updated_at` | timestamptz | NO | `now()` |

**Primary key**

- `app_users_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `app_users_cognito_sub_key`: `UNIQUE (cognito_sub)`

**Check (2)**

- `app_users_cognito_sub_format`: `CHECK (((cognito_sub IS NULL) OR (cognito_sub ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)))`
- `app_users_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'disabled'::text])))`

**Indexes (1 besides the primary key)**

- `app_users_cognito_sub_key`: `UNIQUE btree (cognito_sub)`

### `organization_memberships`

A user's role in an organization (`system_role`) and membership status.

- **Domain:** Identity and tenancy · **Introduced:** migration 0002 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce role data

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `user_id` | uuid | NO |  |
| 4 | `role` | system_role | NO |  |
| 5 | `status` | membership_status | NO | `'active'::membership_status` |
| 6 | `created_at` | timestamptz | NO | `now()` |
| 7 | `updated_at` | timestamptz | NO | `now()` |

**Primary key**

- `organization_memberships_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `organization_memberships_organization_id_user_id_key`: `UNIQUE (organization_id, user_id)`

**Foreign key (2)**

- `organization_memberships_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `organization_memberships_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES app_users(id)`

**Check (1)**

- `organization_memberships_role_check`: `CHECK ((role <> 'platform_owner'::system_role))`

**Indexes (2 besides the primary key)**

- `organization_memberships_organization_id_user_id_key`: `UNIQUE btree (organization_id, user_id)`
- `organization_memberships_user_idx`: `btree (user_id)`

### `permissions`

Catalogue of permission keys (global reference data).

- **Domain:** Identity and tenancy · **Introduced:** migration 0002 · **Tenant key:** none (global/identity table)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** not enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `key` | text | NO |  |
| 2 | `description` | text | NO |  |

**Primary key**

- `permissions_pkey`: `PRIMARY KEY (key)`

### `role_permissions`

Which permission keys each role holds (global reference data).

- **Domain:** Identity and tenancy · **Introduced:** migration 0002 · **Tenant key:** none (global/identity table)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** not enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `role` | system_role | NO |  |
| 2 | `permission_key` | text | NO |  |

**Primary key**

- `role_permissions_pkey`: `PRIMARY KEY (role, permission_key)`

**Foreign key (1)**

- `role_permissions_permission_key_fkey`: `FOREIGN KEY (permission_key) REFERENCES permissions(key)`

## Care directory

### `clients`

Care recipient record as used in operations: random client code, status, city, client type. Legal names are NOT here.

- **Domain:** Care directory · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Soft delete (`deleted_at`)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient operational record (code, city, status)
- **Triggers:** `clients_set_default_client_code` (`set_default_client_code`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_code` | text | NO |  |
| 4 | `caregiver_display_code` | text | yes |  |
| 5 | `status` | client_status | NO | `'active'::client_status` |
| 6 | `created_at` | timestamptz | NO | `now()` |
| 7 | `updated_at` | timestamptz | NO | `now()` |
| 8 | `deleted_at` | timestamptz | yes |  |
| 9 | `city` | text | yes |  |
| 10 | `client_type_id` | uuid | yes |  |

**Primary key**

- `clients_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `clients_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (2)**

- `clients_client_type_fk`: `FOREIGN KEY (client_type_id, organization_id) REFERENCES client_types(id, organization_id)`
- `clients_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (2)**

- `clients_caregiver_display_code_check`: `CHECK (((caregiver_display_code IS NULL) OR ((length(btrim(caregiver_display_code)) >= 3) AND (length(btrim(caregiver_display_code)) <= 40))))`
- `clients_city_check`: `CHECK (((city IS NULL) OR ((length(btrim(city)) >= 1) AND (length(btrim(city)) <= 80))))`

**Indexes (3 besides the primary key)**

- `clients_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `clients_org_client_code_unique`: `UNIQUE btree (organization_id, lower(client_code)) WHERE (deleted_at IS NULL)`
- `clients_org_display_code_unique`: `UNIQUE btree (organization_id, lower(btrim(caregiver_display_code))) WHERE ((caregiver_display_code IS NOT NULL) AND (deleted_at IS NULL))`

### `client_private_names`

Legal first/last name of a client, separated from `clients` and readable only with `clients.names.read`.

- **Domain:** Care directory · **Introduced:** migration 0020 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient DIRECT IDENTIFIER (legal name)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `client_id` | uuid | NO |  |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `legal_first_name` | text | NO |  |
| 4 | `legal_last_name` | text | NO |  |
| 5 | `updated_by` | uuid | NO |  |
| 6 | `updated_at` | timestamptz | NO | `now()` |

**Primary key**

- `client_private_names_pkey`: `PRIMARY KEY (client_id)`

**Foreign key (3)**

- `client_private_names_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `client_private_names_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `client_private_names_updated_by_fkey`: `FOREIGN KEY (updated_by) REFERENCES app_users(id)`

**Check (2)**

- `client_private_names_legal_first_name_check`: `CHECK (((length(btrim(legal_first_name)) >= 1) AND (length(btrim(legal_first_name)) <= 80)))`
- `client_private_names_legal_last_name_check`: `CHECK (((length(btrim(legal_last_name)) >= 1) AND (length(btrim(legal_last_name)) <= 80)))`

### `client_types`

Agency-defined client categories.

- **Domain:** Care directory · **Introduced:** migration 0022 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `name` | text | NO |  |
| 4 | `is_active` | boolean | NO | `true` |
| 5 | `created_by` | uuid | NO |  |
| 6 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `client_types_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `client_types_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (2)**

- `client_types_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `client_types_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (1)**

- `client_types_name_check`: `CHECK (((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 60)))`

**Indexes (2 besides the primary key)**

- `client_types_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `client_types_org_name_unique`: `UNIQUE btree (organization_id, lower(btrim(name)))`

### `services`

Agency service catalogue (code, name, active flag).

- **Domain:** Care directory · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Soft delete (`deleted_at`)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `code` | text | NO |  |
| 4 | `name` | text | NO |  |
| 5 | `color` | text | yes |  |
| 6 | `is_active` | boolean | NO | `true` |
| 7 | `created_at` | timestamptz | NO | `now()` |
| 8 | `updated_at` | timestamptz | NO | `now()` |
| 9 | `deleted_at` | timestamptz | yes |  |

**Primary key**

- `services_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `services_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (1)**

- `services_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Indexes (2 besides the primary key)**

- `services_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `services_org_code_unique`: `UNIQUE btree (organization_id, lower(btrim(code))) WHERE (deleted_at IS NULL)`

### `caregiver_records`

Caregiver (staff) record: code, names, status, hire type, scheduling mode; may link to an `app_users` row.

- **Domain:** Care directory · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Soft delete (`deleted_at`)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce PII (names, code, employment attributes)
- **Triggers:** `caregiver_records_sync_assignment_access` (`sync_record_assignment_access`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `linked_user_id` | uuid | yes |  |
| 4 | `caregiver_code` | text | NO |  |
| 5 | `first_name` | text | NO |  |
| 6 | `last_name` | text | NO |  |
| 7 | `preferred_name` | text | yes |  |
| 8 | `status` | text | NO | `'active'::text` |
| 9 | `created_at` | timestamptz | NO | `now()` |
| 10 | `updated_at` | timestamptz | NO | `now()` |
| 11 | `deleted_at` | timestamptz | yes |  |
| 12 | `hire_type` | text | yes |  |
| 13 | `scheduling_mode` | text | NO | `'fixed'::text` |

**Primary key**

- `caregiver_records_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `caregiver_records_id_organization_id_key`: `UNIQUE (id, organization_id)`
- `caregiver_records_organization_id_caregiver_code_key`: `UNIQUE (organization_id, caregiver_code)`

**Foreign key (2)**

- `caregiver_records_linked_user_id_fkey`: `FOREIGN KEY (linked_user_id) REFERENCES app_users(id)`
- `caregiver_records_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (3)**

- `caregiver_records_hire_type_check`: `CHECK (((hire_type IS NULL) OR (hire_type = ANY (ARRAY['direct_hire'::text, 'eor'::text]))))`
- `caregiver_records_scheduling_mode_check`: `CHECK ((scheduling_mode = ANY (ARRAY['fixed'::text, 'flexible'::text])))`
- `caregiver_records_status_check`: `CHECK ((status = ANY (ARRAY['onboarding'::text, 'ready'::text, 'active'::text, 'inactive'::text])))`

**Indexes (3 besides the primary key)**

- `caregiver_records_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `caregiver_records_one_link_per_user`: `UNIQUE btree (organization_id, linked_user_id) WHERE ((linked_user_id IS NOT NULL) AND (deleted_at IS NULL))`
- `caregiver_records_organization_id_caregiver_code_key`: `UNIQUE btree (organization_id, caregiver_code)`

### `caregiver_assignments`

Standing assignment of a caregiver to a client and service over an effective period, with a family-relationship marker.

- **Domain:** Care directory · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Links a caregiver to a care recipient
- **Triggers:** `assignments_client_requirements` (`client_requirements_commit_guard`), `caregiver_assignments_assert_valid` (`assert_valid_caregiver_assignment`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_user_id` | uuid | yes |  |
| 4 | `client_id` | uuid | NO |  |
| 5 | `service_id` | uuid | NO |  |
| 6 | `effective_start` | date | NO |  |
| 7 | `effective_end` | date | yes |  |
| 8 | `is_active` | boolean | NO | `true` |
| 9 | `created_at` | timestamptz | NO | `now()` |
| 10 | `updated_at` | timestamptz | NO | `now()` |
| 11 | `caregiver_record_id` | uuid | yes |  |
| 12 | `family_relationship` | text | yes |  |

**Primary key**

- `caregiver_assignments_pkey`: `PRIMARY KEY (id)`

**Foreign key (5)**

- `caregiver_assignments_caregiver_user_id_fkey`: `FOREIGN KEY (caregiver_user_id) REFERENCES app_users(id)`
- `caregiver_assignments_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `caregiver_assignments_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_assignments_record_fk`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_assignments_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (3)**

- `caregiver_assignments_family_relationship_check`: `CHECK (((family_relationship IS NULL) OR (family_relationship = ANY (ARRAY['none'::text, 'parent'::text, 'spouse_partner'::text, 'child'::text, 'sibling'::text, 'grandparent'::text, 'grandchild'::text, 'other_relative'::text]))))`
- `caregiver_assignments_has_caregiver`: `CHECK (((caregiver_user_id IS NOT NULL) OR (caregiver_record_id IS NOT NULL)))`
- `caregiver_assignments_period_check`: `CHECK (((effective_end IS NULL) OR (effective_start <= effective_end)))`

**Indexes (2 besides the primary key)**

- `caregiver_assignments_lookup_idx`: `btree (organization_id, caregiver_user_id, client_id, service_id) WHERE is_active`
- `caregiver_assignments_record_idx`: `btree (organization_id, caregiver_record_id) WHERE is_active`

### `caregiver_invitations`

Invitation state for a caregiver sign-in (email, send count, first sign-in).

- **Domain:** Care directory · **Introduced:** migration 0025 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, no policy; not forced · **`ogevia_readonly` grant:** none
- **Sensitivity (analysis):** Workforce PII (email)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `user_id` | uuid | NO |  |
| 5 | `email` | text | NO |  |
| 6 | `existing_account` | boolean | NO |  |
| 7 | `invited_by` | uuid | NO |  |
| 8 | `invited_at` | timestamptz | NO | `now()` |
| 9 | `last_sent_at` | timestamptz | NO | `now()` |
| 10 | `send_count` | integer | NO | `1` |
| 11 | `first_signed_in_at` | timestamptz | yes |  |

**Primary key**

- `caregiver_invitations_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `caregiver_invitations_organization_id_caregiver_record_id_key`: `UNIQUE (organization_id, caregiver_record_id)`

**Foreign key (4)**

- `caregiver_invitations_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_invitations_invited_by_fkey`: `FOREIGN KEY (invited_by) REFERENCES app_users(id)`
- `caregiver_invitations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_invitations_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES app_users(id)`

**Check (2)**

- `caregiver_invitations_email_check`: `CHECK ((length(email) <= 254))`
- `caregiver_invitations_send_count_check`: `CHECK ((send_count >= 1))`

**Indexes (2 besides the primary key)**

- `caregiver_invitations_organization_id_caregiver_record_id_key`: `UNIQUE btree (organization_id, caregiver_record_id)`
- `caregiver_invitations_pending_user_idx`: `btree (user_id) WHERE (first_signed_in_at IS NULL)`

## Authorizations

### `client_authorizations`

Versioned authorization: monthly authorized minutes per client/service/payer/period. Amendments add rows in one `lineage_id`.

- **Domain:** Authorizations · **Introduced:** migration 0004 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; guarded updates only (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient service/payer data; payer and authorization number (free text); rate (financial)
- **Triggers:** `client_authorizations_immutable` (`client_authorizations_guard_update`), `client_authorizations_no_delete` (`forbid_delete`), `client_authorizations_set_lineage` (`client_authorizations_before_insert`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `service_id` | uuid | NO |  |
| 5 | `lineage_id` | uuid | NO |  |
| 6 | `version_number` | integer | NO | `1` |
| 7 | `is_current` | boolean | NO | `true` |
| 8 | `supersedes_id` | uuid | yes |  |
| 9 | `superseded_by_id` | uuid | yes |  |
| 10 | `payer` | text | NO |  |
| 11 | `authorization_number` | text | yes |  |
| 12 | `monthly_authorized_minutes` | integer | NO |  |
| 13 | `period_start` | date | NO |  |
| 14 | `period_end` | date | NO |  |
| 15 | `hourly_rate_cents` | integer | yes |  |
| 16 | `received_date` | date | yes |  |
| 17 | `source_reference` | text | yes |  |
| 18 | `change_reason` | text | yes |  |
| 19 | `created_by` | uuid | yes |  |
| 20 | `created_at` | timestamptz | NO | `now()` |
| 21 | `updated_at` | timestamptz | NO | `now()` |
| 22 | `deleted_at` | timestamptz | yes |  |

**Primary key**

- `client_authorizations_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `client_authorizations_id_organization_id_key`: `UNIQUE (id, organization_id)`
- `client_authorizations_lineage_id_version_number_key`: `UNIQUE (lineage_id, version_number)`

**Foreign key (7)**

- `client_authorizations_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `client_authorizations_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `client_authorizations_lineage_fk`: `FOREIGN KEY (lineage_id) REFERENCES client_authorizations(id)`
- `client_authorizations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `client_authorizations_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`
- `client_authorizations_superseded_by_id_fkey`: `FOREIGN KEY (superseded_by_id) REFERENCES client_authorizations(id)`
- `client_authorizations_supersedes_id_fkey`: `FOREIGN KEY (supersedes_id) REFERENCES client_authorizations(id)`

**Exclusion**

- `client_authorizations_one_current_per_coverage`: `EXCLUDE USING gist (organization_id WITH =, client_id WITH =, service_id WITH =, daterange(period_start, period_end, '[]'::text) WITH &&) WHERE ((is_current AND (deleted_at IS NULL)))`

**Check (6)**

- `client_authorizations_current_not_superseded`: `CHECK ((NOT (is_current AND (superseded_by_id IS NOT NULL))))`
- `client_authorizations_hourly_rate_cents_check`: `CHECK (((hourly_rate_cents IS NULL) OR (hourly_rate_cents >= 0)))`
- `client_authorizations_monthly_authorized_minutes_check`: `CHECK ((monthly_authorized_minutes >= 0))`
- `client_authorizations_period_check`: `CHECK ((period_start < period_end))`
- `client_authorizations_supersede_shape`: `CHECK ((((version_number = 1) AND (supersedes_id IS NULL)) OR ((version_number > 1) AND (supersedes_id IS NOT NULL))))`
- `client_authorizations_version_number_check`: `CHECK ((version_number >= 1))`

**Indexes (5 besides the primary key)**

- `client_authorizations_current_lookup_idx`: `btree (organization_id, client_id, service_id, period_start, period_end) WHERE (is_current AND (deleted_at IS NULL))`
- `client_authorizations_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `client_authorizations_lineage_id_version_number_key`: `UNIQUE btree (lineage_id, version_number)`
- `client_authorizations_lineage_idx`: `btree (lineage_id)`
- `client_authorizations_one_current_per_coverage`: `gist (organization_id, client_id, service_id, daterange(period_start, period_end, '[]'::text)) WHERE (is_current AND (deleted_at IS NULL))`

### `authorization_reservations`

Minutes held against an authorization lineage for a scheduled care-request shift; released with a reason.

- **Domain:** Authorizations · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient scheduling data

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `authorization_lineage_id` | uuid | NO |  |
| 4 | `care_request_id` | uuid | yes |  |
| 5 | `shift_id` | uuid | NO |  |
| 6 | `service_date` | date | NO |  |
| 7 | `reserved_minutes` | integer | NO |  |
| 8 | `released_at` | timestamptz | yes |  |
| 9 | `release_reason` | text | yes |  |
| 10 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `authorization_reservations_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `authorization_reservations_care_request_id_key`: `UNIQUE (care_request_id)`
- `authorization_reservations_shift_id_key`: `UNIQUE (shift_id)`

**Foreign key (4)**

- `authorization_reservations_authorization_lineage_id_fkey`: `FOREIGN KEY (authorization_lineage_id) REFERENCES client_authorizations(id)`
- `authorization_reservations_care_request_id_fkey`: `FOREIGN KEY (care_request_id) REFERENCES care_requests(id)`
- `authorization_reservations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `authorization_reservations_shift_id_fkey`: `FOREIGN KEY (shift_id) REFERENCES shifts(id)`

**Check (1)**

- `authorization_reservations_reserved_minutes_check`: `CHECK ((reserved_minutes > 0))`

**Indexes (3 besides the primary key)**

- `authorization_reservations_care_request_id_key`: `UNIQUE btree (care_request_id)`
- `authorization_reservations_shift_id_key`: `UNIQUE btree (shift_id)`
- `authorization_reservations_usage_idx`: `btree (authorization_lineage_id, service_date) WHERE (released_at IS NULL)`

## Scheduling

### `shifts`

Scheduled work interval for a client (and optionally caregiver, service, authorization lineage, series).

- **Domain:** Scheduling · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient scheduling data; cancel reason (free text)
- **Triggers:** `shifts_client_requirements` (`client_requirements_commit_guard`), `shifts_link_availability_override` (`link_availability_override_to_shift`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `service_id` | uuid | yes |  |
| 5 | `caregiver_user_id` | uuid | yes |  |
| 6 | `caregiver_record_id` | uuid | yes |  |
| 7 | `starts_at` | timestamptz | NO |  |
| 8 | `ends_at` | timestamptz | NO |  |
| 9 | `status` | shift_status | NO | `'scheduled'::shift_status` |
| 10 | `created_at` | timestamptz | NO | `now()` |
| 11 | `updated_at` | timestamptz | NO | `now()` |
| 12 | `authorization_lineage_id` | uuid | yes |  |
| 13 | `created_by` | uuid | yes |  |
| 14 | `cancel_reason` | text | yes |  |
| 15 | `series_id` | uuid | yes |  |

**Primary key**

- `shifts_pkey`: `PRIMARY KEY (id)`

**Foreign key (8)**

- `shifts_authorization_lineage_id_fkey`: `FOREIGN KEY (authorization_lineage_id) REFERENCES client_authorizations(id)`
- `shifts_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `shifts_caregiver_user_id_fkey`: `FOREIGN KEY (caregiver_user_id) REFERENCES app_users(id)`
- `shifts_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `shifts_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `shifts_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `shifts_series_id_fkey`: `FOREIGN KEY (series_id) REFERENCES shift_series(id)`
- `shifts_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (1)**

- `shifts_time_check`: `CHECK ((starts_at < ends_at))`

**Indexes (4 besides the primary key)**

- `shifts_caregiver_record_idx`: `btree (organization_id, caregiver_record_id, starts_at) WHERE (status = 'scheduled'::shift_status)`
- `shifts_org_client_start_idx`: `btree (organization_id, client_id, starts_at)`
- `shifts_org_start_idx`: `btree (organization_id, starts_at)`
- `shifts_series_idx`: `btree (series_id, starts_at) WHERE (series_id IS NOT NULL)`

### `shift_coverage_events`

Append-style history of call-outs and reassignments on a shift.

- **Domain:** Scheduling · **Introduced:** migration 0003 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient scheduling data; reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `shift_id` | uuid | NO |  |
| 4 | `event_type` | shift_coverage_event_type | NO |  |
| 5 | `created_at` | timestamptz | NO | `now()` |
| 6 | `actor_user_id` | uuid | yes |  |
| 7 | `original_caregiver_record_id` | uuid | yes |  |
| 8 | `replacement_caregiver_record_id` | uuid | yes |  |
| 9 | `reason` | text | yes |  |
| 10 | `before_snapshot` | jsonb | yes |  |
| 11 | `after_snapshot` | jsonb | yes |  |

**Primary key**

- `shift_coverage_events_pkey`: `PRIMARY KEY (id)`

**Foreign key (3)**

- `shift_coverage_events_actor_user_id_fkey`: `FOREIGN KEY (actor_user_id) REFERENCES app_users(id)`
- `shift_coverage_events_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `shift_coverage_events_shift_id_fkey`: `FOREIGN KEY (shift_id) REFERENCES shifts(id)`

**Indexes (1 besides the primary key)**

- `shift_coverage_events_shift_idx`: `btree (shift_id, created_at DESC)`

### `shift_series`

Definition of a recurring series of shifts, generated through a date.

- **Domain:** Scheduling · **Introduced:** migration 0034 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient scheduling data

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `service_id` | uuid | NO |  |
| 5 | `caregiver_record_id` | uuid | yes |  |
| 6 | `weekdays` | smallint[] | NO |  |
| 7 | `start_time` | time without time zone | NO |  |
| 8 | `end_time` | time without time zone | NO |  |
| 9 | `starts_on` | date | NO |  |
| 10 | `ends_on` | date | yes |  |
| 11 | `generated_through` | date | NO |  |
| 12 | `status` | text | NO | `'active'::text` |
| 13 | `replaces_series_id` | uuid | yes |  |
| 14 | `created_by` | uuid | NO |  |
| 15 | `created_at` | timestamptz | NO | `now()` |
| 16 | `ended_at` | timestamptz | yes |  |
| 17 | `ended_by` | uuid | yes |  |
| 18 | `end_reason` | text | yes |  |

**Primary key**

- `shift_series_pkey`: `PRIMARY KEY (id)`

**Foreign key (7)**

- `shift_series_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `shift_series_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `shift_series_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `shift_series_ended_by_fkey`: `FOREIGN KEY (ended_by) REFERENCES app_users(id)`
- `shift_series_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `shift_series_replaces_series_id_fkey`: `FOREIGN KEY (replaces_series_id) REFERENCES shift_series(id)`
- `shift_series_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (5)**

- `shift_series_dates`: `CHECK (((ends_on IS NULL) OR (ends_on >= starts_on)))`
- `shift_series_end_shape`: `CHECK ((((status = 'active'::text) AND (ended_at IS NULL) AND (ended_by IS NULL)) OR ((status = 'ended'::text) AND (ended_at IS NOT NULL) AND (ended_by IS NOT NULL) AND (length(btrim(COALESCE(end_reason, ''::text))) > 0))))`
- `shift_series_generated`: `CHECK ((generated_through >= (starts_on - 1)))`
- `shift_series_status_check`: `CHECK ((status = ANY (ARRAY['active'::text, 'ended'::text])))`
- `shift_series_weekdays`: `CHECK (COALESCE(valid_weekdays(weekdays), false))`

**Indexes (1 besides the primary key)**

- `shift_series_org_idx`: `btree (organization_id, status, starts_on)`

### `shift_series_skipped_dates`

Dates deliberately skipped in a series.

- **Domain:** Scheduling · **Introduced:** migration 0034 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Scheduling data; reason (free text)
- **Triggers:** `shift_series_skipped_dates_no_delete` (`forbid_delete`), `shift_series_skipped_dates_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `series_id` | uuid | NO |  |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `local_date` | date | NO |  |
| 4 | `reason` | text | NO |  |
| 5 | `minutes` | integer | NO |  |
| 6 | `recorded_by` | uuid | NO |  |
| 7 | `recorded_at` | timestamptz | NO | `now()` |

**Primary key**

- `shift_series_skipped_dates_pkey`: `PRIMARY KEY (series_id, local_date)`

**Foreign key (3)**

- `shift_series_skipped_dates_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `shift_series_skipped_dates_recorded_by_fkey`: `FOREIGN KEY (recorded_by) REFERENCES app_users(id)`
- `shift_series_skipped_dates_series_id_fkey`: `FOREIGN KEY (series_id) REFERENCES shift_series(id)`

**Check (1)**

- `shift_series_skipped_dates_reason_check`: `CHECK ((reason = ANY (ARRAY['exceeds_authorization'::text, 'no_authorization'::text, 'caregiver_conflict'::text, 'already_started'::text, 'time_does_not_exist'::text, 'time_occurs_twice'::text, 'documents_not_current'::text, 'service_not_approved'::text, 'availability_outside'::text, 'availability_not_provided'::text])))`

## Visits, confirmation and evidence

### `service_visits`

The visit record: server-set times, worked/verified/billable minutes, status, authorization status, snapshots of client code and caregiver name.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; guarded updates only (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient service record; caregiver name snapshot; service notes and reasons (free text)
- **Triggers:** `new_live_visit_readiness` (`new_live_visit_readiness_guard`), `service_visits_billing_approval_guard` (`service_visits_billing_approval_guard`), `service_visits_guard_update` (`service_visits_guard_update`), `service_visits_human_visit_number` (`set_human_visit_number`), `service_visits_no_delete` (`forbid_delete`), `service_visits_release_reservation` (`release_reservation_for_signed_visit`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `client_code_snapshot` | text | NO |  |
| 5 | `caregiver_user_id` | uuid | yes |  |
| 6 | `caregiver_record_id` | uuid | yes |  |
| 7 | `caregiver_name_snapshot` | text | NO |  |
| 8 | `scheduled_shift_id` | uuid | yes |  |
| 9 | `service_authorization_id` | uuid | NO |  |
| 10 | `service_id` | uuid | NO |  |
| 11 | `service_date` | date | NO |  |
| 12 | `time_in` | timestamptz | NO |  |
| 13 | `time_out` | timestamptz | yes |  |
| 14 | `worked_minutes` | integer | yes |  |
| 15 | `verified_minutes` | integer | yes |  |
| 16 | `billable_minutes` | integer | yes |  |
| 17 | `task_categories` | text[] | NO | `'{}'::text[]` |
| 18 | `service_notes` | text | yes |  |
| 19 | `caregiver_attested_at` | timestamptz | yes |  |
| 20 | `status` | service_visit_status | NO | `'draft'::service_visit_status` |
| 21 | `authorization_status` | visit_authorization_status | yes |  |
| 22 | `signed_at` | timestamptz | yes |  |
| 23 | `locked_at` | timestamptz | yes |  |
| 24 | `original_visit_id` | uuid | yes |  |
| 25 | `correction_reason` | text | yes |  |
| 26 | `voided_at` | timestamptz | yes |  |
| 27 | `voided_by` | uuid | yes |  |
| 28 | `void_reason` | text | yes |  |
| 29 | `visit_number_snapshot` | text | NO |  |
| 30 | `created_by` | uuid | NO |  |
| 31 | `created_at` | timestamptz | NO | `now()` |
| 32 | `updated_at` | timestamptz | NO | `now()` |
| 33 | `time_out_entered_by` | uuid | yes |  |
| 34 | `time_out_reason` | text | yes |  |

**Primary key**

- `service_visits_pkey`: `PRIMARY KEY (id)`

**Foreign key (11)**

- `service_visits_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `service_visits_caregiver_user_id_fkey`: `FOREIGN KEY (caregiver_user_id) REFERENCES app_users(id)`
- `service_visits_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `service_visits_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `service_visits_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `service_visits_original_visit_id_fkey`: `FOREIGN KEY (original_visit_id) REFERENCES service_visits(id)`
- `service_visits_scheduled_shift_id_fkey`: `FOREIGN KEY (scheduled_shift_id) REFERENCES shifts(id)`
- `service_visits_service_authorization_id_organization_id_fkey`: `FOREIGN KEY (service_authorization_id, organization_id) REFERENCES client_authorizations(id, organization_id)`
- `service_visits_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`
- `service_visits_time_out_entered_by_fkey`: `FOREIGN KEY (time_out_entered_by) REFERENCES app_users(id)`
- `service_visits_voided_by_fkey`: `FOREIGN KEY (voided_by) REFERENCES app_users(id)`

**Check (10)**

- `service_visits_billable_le_worked`: `CHECK (((billable_minutes IS NULL) OR (worked_minutes IS NULL) OR (billable_minutes <= worked_minutes)))`
- `service_visits_caregiver_present`: `CHECK (((caregiver_user_id IS NOT NULL) OR (caregiver_record_id IS NOT NULL)))`
- `service_visits_correction_shape`: `CHECK (((original_visit_id IS NULL) OR (length(btrim(COALESCE(correction_reason, ''::text))) > 0)))`
- `service_visits_draft_shape`: `CHECK (((status <> 'draft'::service_visit_status) OR ((time_out IS NULL) AND (worked_minutes IS NULL) AND (signed_at IS NULL))))`
- `service_visits_ended_shape`: `CHECK (((status = ANY (ARRAY['draft'::service_visit_status, 'voided'::service_visit_status])) OR ((time_out IS NOT NULL) AND (worked_minutes IS NOT NULL))))`
- `service_visits_locked_shape`: `CHECK (((status <> ALL (ARRAY['signed'::service_visit_status, 'administrator_review'::service_visit_status, 'corrected'::service_visit_status])) OR ((verified_minutes IS NOT NULL) AND (billable_minutes IS NOT NULL) AND (authorization_status IS NOT NULL) AND (signed_at IS NOT NULL) AND (locked_at IS NOT NULL))))`
- `service_visits_minutes_nonnegative`: `CHECK ((((verified_minutes IS NULL) OR (verified_minutes >= 0)) AND ((billable_minutes IS NULL) OR (billable_minutes >= 0))))`
- `service_visits_time_check`: `CHECK (((time_out IS NULL) OR (time_out > time_in)))`
- `service_visits_voided_shape`: `CHECK (((status <> 'voided'::service_visit_status) OR ((voided_at IS NOT NULL) AND (voided_by IS NOT NULL) AND (length(btrim(COALESCE(void_reason, ''::text))) > 0))))`
- `service_visits_worked_range`: `CHECK (((worked_minutes IS NULL) OR ((worked_minutes >= 1) AND (worked_minutes <= 1440))))`

**Indexes (9 besides the primary key)**

- `service_visits_authorization_date_idx`: `btree (service_authorization_id, service_date) WHERE (status = ANY (ARRAY['signed'::service_visit_status, 'administrator_review'::service_visit_status]))`
- `service_visits_caregiver_date_idx`: `btree (caregiver_user_id, service_date DESC)`
- `service_visits_client_idx`: `btree (client_id)`
- `service_visits_one_open_per_caregiver_record`: `UNIQUE btree (caregiver_record_id) WHERE ((caregiver_record_id IS NOT NULL) AND (status = ANY (ARRAY['draft'::service_visit_status, 'awaiting_signature'::service_visit_status])))`
- `service_visits_one_open_per_caregiver_user`: `UNIQUE btree (caregiver_user_id) WHERE ((caregiver_user_id IS NOT NULL) AND (status = ANY (ARRAY['draft'::service_visit_status, 'awaiting_signature'::service_visit_status])))`
- `service_visits_org_date_idx`: `btree (organization_id, service_date DESC)`
- `service_visits_org_status_idx`: `btree (organization_id, status)`
- `service_visits_original_idx`: `btree (original_visit_id) WHERE (original_visit_id IS NOT NULL)`
- `service_visits_shift_unique`: `UNIQUE btree (scheduled_shift_id) WHERE ((scheduled_shift_id IS NOT NULL) AND (status <> ALL (ARRAY['voided'::service_visit_status, 'corrected'::service_visit_status])))`

### `visit_evidence`

Metadata for an evidence object in S3 (key, S3 version id, size, SHA-256). Image bytes are never in PostgreSQL.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Evidence metadata (object key is UUID-only)
- **Triggers:** `visit_evidence_append_only` (`forbid_update`), `visit_evidence_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `evidence_type` | text | NO | `'client_signature'::text` |
| 5 | `storage_provider` | text | NO | `'s3'::text` |
| 6 | `object_key` | text | NO |  |
| 7 | `object_version_id` | text | yes |  |
| 8 | `content_type` | text | NO |  |
| 9 | `byte_size` | integer | NO |  |
| 10 | `sha256_hex` | text | NO |  |
| 11 | `registered_by` | uuid | NO |  |
| 12 | `registered_at` | timestamptz | NO | `now()` |
| 13 | `request_id` | uuid | yes |  |

**Primary key**

- `visit_evidence_pkey`: `PRIMARY KEY (id)`

**Foreign key (3)**

- `visit_evidence_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_evidence_registered_by_fkey`: `FOREIGN KEY (registered_by) REFERENCES app_users(id)`
- `visit_evidence_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (6)**

- `visit_evidence_byte_size_check`: `CHECK (((byte_size >= 1) AND (byte_size <= 1048576)))`
- `visit_evidence_content_type_check`: `CHECK ((content_type = 'image/png'::text))`
- `visit_evidence_evidence_type_check`: `CHECK ((evidence_type = 'client_signature'::text))`
- `visit_evidence_key_shape`: `CHECK ((object_key = ((((organization_id)::text || '/'::text) || (visit_id)::text) || '/client-signature.png'::text)))`
- `visit_evidence_sha256_hex_check`: `CHECK ((sha256_hex ~ '^[0-9a-f]{64}$'::text))`
- `visit_evidence_storage_provider_check`: `CHECK ((storage_provider = 's3'::text))`

**Indexes (1 besides the primary key)**

- `visit_evidence_visit_idx`: `btree (visit_id, registered_at DESC)`

### `visit_confirmations`

The client/representative confirmation of a visit with an immutable snapshot of what was confirmed.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Signer name (typed), relationship, reason (free text); snapshot with client code and caregiver name
- **Triggers:** `visit_confirmations_append_only` (`forbid_update`), `visit_confirmations_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `signer_role` | visit_signer_role | NO |  |
| 5 | `confirmation_method` | text | NO |  |
| 6 | `evidence_id` | uuid | yes |  |
| 7 | `typed_signer_name` | text | yes |  |
| 8 | `signer_relationship` | text | yes |  |
| 9 | `confirmation_reason` | text | yes |  |
| 10 | `confirmed_visit_snapshot` | jsonb | NO |  |
| 11 | `confirmation_version` | integer | NO |  |
| 12 | `confirmed_by` | uuid | NO |  |
| 13 | `confirmed_at` | timestamptz | NO | `now()` |
| 14 | `request_id` | uuid | yes |  |

**Primary key**

- `visit_confirmations_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `visit_confirmations_visit_id_key`: `UNIQUE (visit_id)`

**Foreign key (4)**

- `visit_confirmations_confirmed_by_fkey`: `FOREIGN KEY (confirmed_by) REFERENCES app_users(id)`
- `visit_confirmations_evidence_id_fkey`: `FOREIGN KEY (evidence_id) REFERENCES visit_evidence(id)`
- `visit_confirmations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_confirmations_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (4)**

- `visit_confirmations_confirmation_method_check`: `CHECK ((confirmation_method = ANY (ARRAY['draw'::text, 'typed'::text, 'verbal'::text, 'assisted_mark'::text, 'unable_to_confirm'::text])))`
- `visit_confirmations_method_evidence`: `CHECK ((((confirmation_method = ANY (ARRAY['draw'::text, 'assisted_mark'::text])) AND (evidence_id IS NOT NULL)) OR ((confirmation_method <> ALL (ARRAY['draw'::text, 'assisted_mark'::text])) AND (evidence_id IS NULL))))`
- `visit_confirmations_typed_name`: `CHECK (((confirmation_method <> ALL (ARRAY['typed'::text, 'verbal'::text])) OR (length(btrim(COALESCE(typed_signer_name, ''::text))) > 0)))`
- `visit_confirmations_unable_reason`: `CHECK (((confirmation_method <> 'unable_to_confirm'::text) OR (length(btrim(COALESCE(confirmation_reason, ''::text))) > 0)))`

**Indexes (1 besides the primary key)**

- `visit_confirmations_visit_id_key`: `UNIQUE btree (visit_id)`

### `visit_corrections`

Append-only record linking an original visit to its corrected visit with the reason.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Correction reason (free text)
- **Triggers:** `visit_corrections_append_only` (`forbid_update`), `visit_corrections_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `original_visit_id` | uuid | NO |  |
| 4 | `corrected_visit_id` | uuid | NO |  |
| 5 | `corrected_by` | uuid | NO |  |
| 6 | `reason` | text | NO |  |
| 7 | `before_snapshot` | jsonb | NO |  |
| 8 | `after_snapshot` | jsonb | NO |  |
| 9 | `created_at` | timestamptz | NO | `now()` |
| 10 | `request_id` | uuid | yes |  |

**Primary key**

- `visit_corrections_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `visit_corrections_corrected_visit_id_key`: `UNIQUE (corrected_visit_id)`
- `visit_corrections_original_visit_id_key`: `UNIQUE (original_visit_id)`

**Foreign key (4)**

- `visit_corrections_corrected_by_fkey`: `FOREIGN KEY (corrected_by) REFERENCES app_users(id)`
- `visit_corrections_corrected_visit_id_fkey`: `FOREIGN KEY (corrected_visit_id) REFERENCES service_visits(id)`
- `visit_corrections_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_corrections_original_visit_id_fkey`: `FOREIGN KEY (original_visit_id) REFERENCES service_visits(id)`

**Check (1)**

- `visit_corrections_reason_check`: `CHECK ((length(btrim(reason)) > 0))`

**Indexes (3 besides the primary key)**

- `visit_corrections_corrected_visit_id_key`: `UNIQUE btree (corrected_visit_id)`
- `visit_corrections_org_idx`: `btree (organization_id)`
- `visit_corrections_original_visit_id_key`: `UNIQUE btree (original_visit_id)`

### `visit_review_decisions`

Recorded administrator decision for a visit that needs review (accept capped billable / close not billable); revocable.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0031 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Guarded updates (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Review reason (free text)
- **Triggers:** `visit_review_decisions_guard` (`visit_review_decisions_guard`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `decision` | text | NO |  |
| 5 | `reason` | text | NO |  |
| 6 | `review_reasons` | text[] | NO |  |
| 7 | `visit_snapshot` | jsonb | NO |  |
| 8 | `decided_by` | uuid | NO |  |
| 9 | `decided_at` | timestamptz | NO | `now()` |
| 10 | `revoked_at` | timestamptz | yes |  |
| 11 | `revoked_by` | uuid | yes |  |
| 12 | `revoke_reason` | text | yes |  |
| 13 | `request_id` | uuid | yes |  |
| 14 | `late_confirmation_review_id` | uuid | yes |  |
| 15 | `accepted_minutes` | integer | yes |  |

**Primary key**

- `visit_review_decisions_pkey`: `PRIMARY KEY (id)`

**Foreign key (5)**

- `visit_review_decisions_decided_by_fkey`: `FOREIGN KEY (decided_by) REFERENCES app_users(id)`
- `visit_review_decisions_late_confirmation_review_id_fkey`: `FOREIGN KEY (late_confirmation_review_id) REFERENCES visit_late_confirmation_reviews(id)`
- `visit_review_decisions_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_review_decisions_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES app_users(id)`
- `visit_review_decisions_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (4)**

- `visit_review_decisions_decision_check`: `CHECK ((decision = ANY (ARRAY['accept_capped_billable'::text, 'close_not_billable'::text, 'accept_late_confirmation'::text])))`
- `visit_review_decisions_late_shape`: `CHECK ((((decision = 'accept_late_confirmation'::text) = (late_confirmation_review_id IS NOT NULL)) AND ((decision = 'accept_late_confirmation'::text) = (accepted_minutes IS NOT NULL)) AND ((accepted_minutes IS NULL) OR (accepted_minutes > 0))))`
- `visit_review_decisions_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 1000)))`
- `visit_review_decisions_revoke_shape`: `CHECK ((((revoked_at IS NULL) AND (revoked_by IS NULL) AND (revoke_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (revoked_by IS NOT NULL) AND (length(btrim(COALESCE(revoke_reason, ''::text))) > 0))))`

**Indexes (2 besides the primary key)**

- `visit_review_decisions_one_active`: `UNIQUE btree (visit_id) WHERE (revoked_at IS NULL)`
- `visit_review_decisions_org_idx`: `btree (organization_id, decided_at DESC)`

### `visit_confirmation_requests`

Request to collect a missing confirmation later (secure link plus one-time code, or paper). Token and code stored as hashes.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0036 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Guarded updates (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Credential-like (token hash, code hash); recipient name
- **Triggers:** `visit_confirmation_requests_guard` (`visit_confirmation_requests_guard`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `channel` | text | NO |  |
| 5 | `recipient_name` | text | NO |  |
| 6 | `recipient_role` | visit_signer_role | NO |  |
| 7 | `identity_check` | text | yes |  |
| 8 | `token_hash` | text | yes |  |
| 9 | `code_hash` | text | yes |  |
| 10 | `failed_code_attempts` | integer | NO | `0` |
| 11 | `locked_at` | timestamptz | yes |  |
| 12 | `visit_snapshot` | jsonb | NO |  |
| 13 | `expires_at` | timestamptz | NO |  |
| 14 | `responded_at` | timestamptz | yes |  |
| 15 | `revoked_at` | timestamptz | yes |  |
| 16 | `revoked_by` | uuid | yes |  |
| 17 | `revoke_reason` | text | yes |  |
| 18 | `created_by` | uuid | NO |  |
| 19 | `created_at` | timestamptz | NO | `now()` |
| 20 | `request_id` | uuid | yes |  |

**Primary key**

- `visit_confirmation_requests_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `visit_confirmation_requests_token_hash_key`: `UNIQUE (token_hash)`

**Foreign key (4)**

- `visit_confirmation_requests_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `visit_confirmation_requests_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_confirmation_requests_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES app_users(id)`
- `visit_confirmation_requests_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (9)**

- `visit_confirmation_requests_channel_check`: `CHECK ((channel = ANY (ARRAY['link'::text, 'paper'::text])))`
- `visit_confirmation_requests_code_hash_check`: `CHECK (((code_hash IS NULL) OR (code_hash ~ '^[0-9a-f]{64}$'::text)))`
- `visit_confirmation_requests_expiry`: `CHECK ((expires_at > created_at))`
- `visit_confirmation_requests_failed_code_attempts_check`: `CHECK (((failed_code_attempts >= 0) AND (failed_code_attempts <= 5)))`
- `visit_confirmation_requests_identity_check_check`: `CHECK (((identity_check IS NULL) OR ((length(btrim(identity_check)) >= 5) AND (length(btrim(identity_check)) <= 500))))`
- `visit_confirmation_requests_link_shape`: `CHECK ((((channel = 'link'::text) AND (token_hash IS NOT NULL) AND (code_hash IS NOT NULL) AND (identity_check IS NOT NULL)) OR ((channel = 'paper'::text) AND (token_hash IS NULL) AND (code_hash IS NULL))))`
- `visit_confirmation_requests_recipient_name_check`: `CHECK (((length(btrim(recipient_name)) >= 2) AND (length(btrim(recipient_name)) <= 200)))`
- `visit_confirmation_requests_revoke_shape`: `CHECK ((((revoked_at IS NULL) AND (revoked_by IS NULL) AND (revoke_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (revoked_by IS NOT NULL) AND (length(btrim(COALESCE(revoke_reason, ''::text))) > 0))))`
- `visit_confirmation_requests_token_hash_check`: `CHECK (((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text)))`

**Indexes (3 besides the primary key)**

- `visit_confirmation_requests_one_open`: `UNIQUE btree (visit_id) WHERE ((responded_at IS NULL) AND (revoked_at IS NULL))`
- `visit_confirmation_requests_org_idx`: `btree (organization_id, created_at DESC)`
- `visit_confirmation_requests_token_hash_key`: `UNIQUE btree (token_hash)`

### `visit_late_confirmations`

Append-only response to a confirmation request (electronic or paper) with the snapshot it confirmed.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0036 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Signer name, dispute reason (free text), evidence key
- **Triggers:** `visit_late_confirmations_no_delete` (`forbid_delete`), `visit_late_confirmations_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO |  |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `request_id` | uuid | NO |  |
| 5 | `outcome` | text | NO |  |
| 6 | `method` | text | yes |  |
| 7 | `signer_name` | text | NO |  |
| 8 | `signer_role` | visit_signer_role | NO |  |
| 9 | `dispute_reason` | text | yes |  |
| 10 | `attestation_version` | text | NO |  |
| 11 | `confirmed_visit_snapshot` | jsonb | NO |  |
| 12 | `signed_on` | date | yes |  |
| 13 | `evidence_object_key` | text | yes |  |
| 14 | `evidence_version_id` | text | yes |  |
| 15 | `evidence_content_type` | text | yes |  |
| 16 | `evidence_byte_size` | integer | yes |  |
| 17 | `evidence_sha256` | text | yes |  |
| 18 | `received_at` | timestamptz | NO | `now()` |
| 19 | `recorded_by` | uuid | yes |  |
| 20 | `response_key` | uuid | NO |  |
| 21 | `request_id_header` | uuid | yes |  |

**Primary key**

- `visit_late_confirmations_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `visit_late_confirmations_request_id_key`: `UNIQUE (request_id)`

**Foreign key (4)**

- `visit_late_confirmations_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_late_confirmations_recorded_by_fkey`: `FOREIGN KEY (recorded_by) REFERENCES app_users(id)`
- `visit_late_confirmations_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES visit_confirmation_requests(id)`
- `visit_late_confirmations_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (5)**

- `visit_late_confirmations_evidence_shape`: `CHECK ((((evidence_object_key IS NULL) AND (evidence_byte_size IS NULL) AND (evidence_sha256 IS NULL) AND (evidence_content_type IS NULL)) OR ((evidence_object_key IS NOT NULL) AND ((evidence_byte_size >= 1) AND (evidence_byte_size <= 10485760)) AND (evidence_sha256 ~ '^[0-9a-f]{64}$'::text))))`
- `visit_late_confirmations_method_check`: `CHECK ((method = ANY (ARRAY['draw'::text, 'typed'::text, 'paper'::text])))`
- `visit_late_confirmations_outcome_check`: `CHECK ((outcome = ANY (ARRAY['confirmed'::text, 'disputed'::text])))`
- `visit_late_confirmations_shape`: `CHECK ((((outcome = 'disputed'::text) AND (method IS NULL) AND (evidence_object_key IS NULL) AND ((length(btrim(COALESCE(dispute_reason, ''::text))) >= 3) AND (length(btrim(COALESCE(dispute_reason, ''::text))) <= 1000))) OR ((outcome = 'confirmed'::text) AND (dispute_reason IS NULL) AND (((method = 'typed'::text) AND (evidence_object_key IS NULL)) OR ((method = 'draw'::text) AND (evidence_content_type = 'image/png'::text) AND (evidence_object_key = ((((organization_id)::text || '/'::text) || (id)::text) || '/client-signature.png'::text))) OR ((method = 'paper'::text) AND (recorded_by IS NOT NULL) AND (signed_on IS NOT NULL) AND (evidence_content_type = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text])) AND (evidence_object_key = ((((organization_id)::text || '/documents/'::text) || (id)::text) || '/paper-form'::text)))))))`
- `visit_late_confirmations_signer_name_check`: `CHECK (((length(btrim(signer_name)) >= 2) AND (length(btrim(signer_name)) <= 200)))`

**Indexes (2 besides the primary key)**

- `visit_late_confirmations_request_id_key`: `UNIQUE btree (request_id)`
- `visit_late_confirmations_visit_idx`: `btree (visit_id, received_at DESC)`

### `visit_late_confirmation_reviews`

Append-only staff review of a late confirmation.

- **Domain:** Visits, confirmation and evidence · **Introduced:** migration 0036 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Review reason (free text)
- **Triggers:** `visit_late_confirmation_reviews_no_delete` (`forbid_delete`), `visit_late_confirmation_reviews_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `late_confirmation_id` | uuid | NO |  |
| 4 | `visit_id` | uuid | NO |  |
| 5 | `outcome` | text | NO |  |
| 6 | `reason` | text | NO |  |
| 7 | `accepted_minutes` | integer | yes |  |
| 8 | `capped_by_authorization` | boolean | yes |  |
| 9 | `decided_by` | uuid | NO |  |
| 10 | `decided_at` | timestamptz | NO | `now()` |
| 11 | `request_id` | uuid | yes |  |

**Primary key**

- `visit_late_confirmation_reviews_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `visit_late_confirmation_reviews_late_confirmation_id_key`: `UNIQUE (late_confirmation_id)`

**Foreign key (4)**

- `visit_late_confirmation_reviews_decided_by_fkey`: `FOREIGN KEY (decided_by) REFERENCES app_users(id)`
- `visit_late_confirmation_reviews_late_confirmation_id_fkey`: `FOREIGN KEY (late_confirmation_id) REFERENCES visit_late_confirmations(id)`
- `visit_late_confirmation_reviews_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `visit_late_confirmation_reviews_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (3)**

- `visit_late_confirmation_reviews_minutes`: `CHECK ((((outcome = 'accepted'::text) AND (accepted_minutes > 0) AND (capped_by_authorization IS NOT NULL)) OR ((outcome = 'rejected'::text) AND (accepted_minutes IS NULL) AND (capped_by_authorization IS NULL))))`
- `visit_late_confirmation_reviews_outcome_check`: `CHECK ((outcome = ANY (ARRAY['accepted'::text, 'rejected'::text])))`
- `visit_late_confirmation_reviews_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 1000)))`

**Indexes (1 besides the primary key)**

- `visit_late_confirmation_reviews_late_confirmation_id_key`: `UNIQUE btree (late_confirmation_id)`

## Billing readiness

### `billing_approvals`

Human approval of billable minutes for a visit; one active approval per visit; void keeps history.

- **Domain:** Billing readiness · **Introduced:** migration 0019 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; guarded updates only (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Financial (rate, amount; owner-only visibility); notes (free text)
- **Triggers:** `billing_approvals_guard_update` (`billing_approvals_guard_update`), `billing_approvals_no_delete` (`forbid_delete`), `billing_approvals_rounding_guard` (`billing_approvals_rounding_guard`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `visit_id` | uuid | NO |  |
| 4 | `approved_by` | uuid | NO |  |
| 5 | `approved_at` | timestamptz | NO | `now()` |
| 6 | `approved_minutes` | integer | NO |  |
| 7 | `billable_minutes_at_approval` | integer | NO |  |
| 8 | `notes` | text | yes |  |
| 9 | `rate_cents` | integer | yes |  |
| 10 | `amount_cents` | integer | yes |  |
| 11 | `source_snapshot` | jsonb | NO |  |
| 12 | `voided_at` | timestamptz | yes |  |
| 13 | `voided_by` | uuid | yes |  |
| 14 | `void_reason` | text | yes |  |

**Primary key**

- `billing_approvals_pkey`: `PRIMARY KEY (id)`

**Foreign key (4)**

- `billing_approvals_approved_by_fkey`: `FOREIGN KEY (approved_by) REFERENCES app_users(id)`
- `billing_approvals_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `billing_approvals_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`
- `billing_approvals_voided_by_fkey`: `FOREIGN KEY (voided_by) REFERENCES app_users(id)`

**Check (6)**

- `billing_approvals_amount_cents_check`: `CHECK (((amount_cents IS NULL) OR (amount_cents >= 0)))`
- `billing_approvals_approved_minutes_check`: `CHECK ((approved_minutes >= 0))`
- `billing_approvals_billable_minutes_at_approval_check`: `CHECK ((billable_minutes_at_approval >= 0))`
- `billing_approvals_minutes_le_billable`: `CHECK ((approved_minutes <= billable_minutes_at_approval))`
- `billing_approvals_rate_cents_check`: `CHECK (((rate_cents IS NULL) OR (rate_cents >= 0)))`
- `billing_approvals_void_shape`: `CHECK ((((voided_at IS NULL) AND (voided_by IS NULL) AND (void_reason IS NULL)) OR ((voided_at IS NOT NULL) AND (voided_by IS NOT NULL) AND (length(btrim(COALESCE(void_reason, ''::text))) > 0))))`

**Indexes (2 besides the primary key)**

- `billing_approvals_active_visit_unique`: `UNIQUE btree (visit_id) WHERE (voided_at IS NULL)`
- `billing_approvals_org_time_idx`: `btree (organization_id, approved_at DESC)`

### `billing_rounding_policies`

Agency/payer billing rounding rule with its reference and date.

- **Domain:** Billing readiness · **Introduced:** migration 0029 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Financial configuration; payer label/key
- **Triggers:** `billing_rounding_policies_no_delete` (`forbid_delete`), `billing_rounding_policies_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `payer_key` | text | NO |  |
| 4 | `payer_label` | text | NO |  |
| 5 | `service_id` | uuid | NO |  |
| 6 | `version` | integer | NO |  |
| 7 | `method` | text | NO |  |
| 8 | `increment_minutes` | integer | yes |  |
| 9 | `basis` | text | yes |  |
| 10 | `payer_rule_reference` | text | yes |  |
| 11 | `payer_rule_date` | date | yes |  |
| 12 | `effective_from` | date | NO |  |
| 13 | `reason` | text | NO |  |
| 14 | `created_by` | uuid | NO |  |
| 15 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `billing_rounding_policies_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `billing_rounding_policies_organization_id_payer_key_service_key`: `UNIQUE (organization_id, payer_key, service_id, version)`

**Foreign key (3)**

- `billing_rounding_policies_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `billing_rounding_policies_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `billing_rounding_policies_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (6)**

- `billing_rounding_policies_method_check`: `CHECK ((method = ANY (ARRAY['none'::text, 'nearest'::text, 'up'::text, 'down'::text])))`
- `billing_rounding_policies_payer_key_check`: `CHECK (((length(payer_key) > 0) AND (payer_key = lower(btrim(payer_key)))))`
- `billing_rounding_policies_payer_label_check`: `CHECK ((length(btrim(payer_label)) > 0))`
- `billing_rounding_policies_reason_check`: `CHECK ((length(btrim(reason)) > 0))`
- `billing_rounding_policies_shape`: `CHECK ((((method = 'none'::text) AND (increment_minutes IS NULL) AND (basis IS NULL)) OR ((method <> 'none'::text) AND ((COALESCE(increment_minutes, 0) >= 1) AND (COALESCE(increment_minutes, 0) <= 240)) AND (COALESCE(basis, ''::text) = ANY (ARRAY['per_visit'::text, 'daily_total'::text])) AND (length(btrim(COALESCE(payer_rule_reference, ''::text))) >= 5) AND (payer_rule_date IS NOT NULL))))`
- `billing_rounding_policies_version_check`: `CHECK ((version >= 1))`

**Indexes (2 besides the primary key)**

- `billing_rounding_policies_lookup`: `btree (organization_id, payer_key, service_id, effective_from)`
- `billing_rounding_policies_organization_id_payer_key_service_key`: `UNIQUE btree (organization_id, payer_key, service_id, version)`

### `billing_rounding_adjustments`

Approved rounding adjustment on a visit, voidable.

- **Domain:** Billing readiness · **Introduced:** migration 0029 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; guarded updates only (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Financial (rate, amount); notes (free text)
- **Triggers:** `billing_rounding_adjustments_guard_update` (`billing_rounding_adjustments_guard_update`), `billing_rounding_adjustments_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `unit_kind` | text | NO |  |
| 4 | `visit_id` | uuid | yes |  |
| 5 | `authorization_lineage_id` | uuid | NO |  |
| 6 | `client_id` | uuid | NO |  |
| 7 | `service_id` | uuid | NO |  |
| 8 | `service_date` | date | NO |  |
| 9 | `policy_id` | uuid | NO |  |
| 10 | `covered_visit_ids` | uuid[] | NO |  |
| 11 | `base_minutes` | integer | NO |  |
| 12 | `proposed_minutes` | integer | NO |  |
| 13 | `adjustment_minutes` | integer | NO |  |
| 14 | `capped_by_authorization` | boolean | NO |  |
| 15 | `rate_cents` | integer | yes |  |
| 16 | `amount_cents` | integer | yes |  |
| 17 | `notes` | text | yes |  |
| 18 | `approved_by` | uuid | NO |  |
| 19 | `approved_at` | timestamptz | NO | `now()` |
| 20 | `voided_at` | timestamptz | yes |  |
| 21 | `voided_by` | uuid | yes |  |
| 22 | `void_reason` | text | yes |  |

**Primary key**

- `billing_rounding_adjustments_pkey`: `PRIMARY KEY (id)`

**Foreign key (7)**

- `billing_rounding_adjustments_approved_by_fkey`: `FOREIGN KEY (approved_by) REFERENCES app_users(id)`
- `billing_rounding_adjustments_client_id_fkey`: `FOREIGN KEY (client_id) REFERENCES clients(id)`
- `billing_rounding_adjustments_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `billing_rounding_adjustments_policy_id_fkey`: `FOREIGN KEY (policy_id) REFERENCES billing_rounding_policies(id)`
- `billing_rounding_adjustments_service_id_fkey`: `FOREIGN KEY (service_id) REFERENCES services(id)`
- `billing_rounding_adjustments_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`
- `billing_rounding_adjustments_voided_by_fkey`: `FOREIGN KEY (voided_by) REFERENCES app_users(id)`

**Check (9)**

- `billing_rounding_adjustments_adjustment_minutes_check`: `CHECK ((adjustment_minutes <> 0))`
- `billing_rounding_adjustments_base_minutes_check`: `CHECK ((base_minutes >= 0))`
- `billing_rounding_adjustments_check`: `CHECK ((adjustment_minutes = (proposed_minutes - base_minutes)))`
- `billing_rounding_adjustments_check1`: `CHECK (((unit_kind = 'visit'::text) = (visit_id IS NOT NULL)))`
- `billing_rounding_adjustments_check2`: `CHECK ((((voided_at IS NULL) AND (voided_by IS NULL) AND (void_reason IS NULL)) OR ((voided_at IS NOT NULL) AND (voided_by IS NOT NULL) AND (length(btrim(COALESCE(void_reason, ''::text))) > 0))))`
- `billing_rounding_adjustments_covered_visit_ids_check`: `CHECK ((cardinality(covered_visit_ids) >= 1))`
- `billing_rounding_adjustments_proposed_minutes_check`: `CHECK ((proposed_minutes >= 0))`
- `billing_rounding_adjustments_rate_cents_check`: `CHECK (((rate_cents IS NULL) OR (rate_cents >= 0)))`
- `billing_rounding_adjustments_unit_kind_check`: `CHECK ((unit_kind = ANY (ARRAY['visit'::text, 'day'::text])))`

**Indexes (3 besides the primary key)**

- `billing_rounding_adjustments_active_day`: `UNIQUE btree (authorization_lineage_id, service_date) WHERE ((voided_at IS NULL) AND (unit_kind = 'day'::text))`
- `billing_rounding_adjustments_active_visit`: `UNIQUE btree (visit_id) WHERE ((voided_at IS NULL) AND (unit_kind = 'visit'::text))`
- `billing_rounding_adjustments_month`: `btree (authorization_lineage_id, service_date) WHERE (voided_at IS NULL)`

## Continuity

### `continuity_exports`

Log of continuity-pack downloads (who, when, counts). No pack content is stored.

- **Domain:** Continuity · **Introduced:** migration 0027 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Counts and who/when only
- **Triggers:** `continuity_exports_no_delete` (`forbid_delete`), `continuity_exports_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `exported_by` | uuid | NO |  |
| 4 | `request_key` | uuid | NO |  |
| 5 | `data_as_of` | timestamptz | NO |  |
| 6 | `outage_number_first` | integer | NO |  |
| 7 | `outage_number_last` | integer | NO |  |
| 8 | `shift_count` | integer | NO |  |
| 9 | `client_count` | integer | NO |  |
| 10 | `authorization_count` | integer | NO |  |
| 11 | `caregiver_count` | integer | NO |  |
| 12 | `includes_client_names` | boolean | NO |  |
| 13 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `continuity_exports_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `continuity_exports_organization_id_outage_number_first_key`: `UNIQUE (organization_id, outage_number_first)`
- `continuity_exports_organization_id_request_key_key`: `UNIQUE (organization_id, request_key)`

**Foreign key (2)**

- `continuity_exports_exported_by_fkey`: `FOREIGN KEY (exported_by) REFERENCES app_users(id)`
- `continuity_exports_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (2)**

- `continuity_exports_check`: `CHECK ((outage_number_last >= outage_number_first))`
- `continuity_exports_outage_number_first_check`: `CHECK ((outage_number_first >= 1))`

**Indexes (3 besides the primary key)**

- `continuity_exports_org_time_idx`: `btree (organization_id, created_at DESC)`
- `continuity_exports_organization_id_outage_number_first_key`: `UNIQUE btree (organization_id, outage_number_first)`
- `continuity_exports_organization_id_request_key_key`: `UNIQUE btree (organization_id, request_key)`

### `outage_visit_records`

Pre-numbered outage visit records used while Ogevia is unavailable, reconciled to visits afterwards.

- **Domain:** Continuity · **Introduced:** migration 0028 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Signer name, notes (free text), paper confirmation reference
- **Triggers:** `outage_visit_records_no_delete` (`forbid_delete`), `outage_visit_records_no_update` (`forbid_update`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `outage_number` | integer | NO |  |
| 4 | `state` | text | NO |  |
| 5 | `visit_id` | uuid | yes |  |
| 6 | `paper_confirmation` | text | yes |  |
| 7 | `signer_name` | text | yes |  |
| 8 | `notes` | text | yes |  |
| 9 | `reason_not_used` | text | yes |  |
| 10 | `entered_by` | uuid | NO |  |
| 11 | `entered_at` | timestamptz | NO | `now()` |

**Primary key**

- `outage_visit_records_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `outage_visit_records_organization_id_outage_number_key`: `UNIQUE (organization_id, outage_number)`
- `outage_visit_records_visit_id_key`: `UNIQUE (visit_id)`

**Foreign key (3)**

- `outage_visit_records_entered_by_fkey`: `FOREIGN KEY (entered_by) REFERENCES app_users(id)`
- `outage_visit_records_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `outage_visit_records_visit_id_fkey`: `FOREIGN KEY (visit_id) REFERENCES service_visits(id)`

**Check (4)**

- `outage_visit_records_check`: `CHECK ((((state = 'entered'::text) AND (visit_id IS NOT NULL) AND (paper_confirmation IS NOT NULL)) OR ((state = 'not_used'::text) AND (visit_id IS NULL) AND (length(btrim(COALESCE(reason_not_used, ''::text))) > 0))))`
- `outage_visit_records_outage_number_check`: `CHECK ((outage_number >= 1))`
- `outage_visit_records_paper_confirmation_check`: `CHECK ((paper_confirmation = ANY (ARRAY['signature_on_form'::text, 'verbal'::text, 'unable_to_confirm'::text, 'declined'::text])))`
- `outage_visit_records_state_check`: `CHECK ((state = ANY (ARRAY['entered'::text, 'not_used'::text])))`

**Indexes (2 besides the primary key)**

- `outage_visit_records_organization_id_outage_number_key`: `UNIQUE btree (organization_id, outage_number)`
- `outage_visit_records_visit_id_key`: `UNIQUE btree (visit_id)`

## Care requests and portals

### `client_care_portals`

Opaque-link portal for a client/family to submit care requests. Token stored as a hash; expiry and revocation tracked.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Credential-like (token hash); label (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `token_hash` | text | NO |  |
| 5 | `label` | text | yes |  |
| 6 | `is_active` | boolean | NO | `true` |
| 7 | `expires_at` | timestamptz | yes |  |
| 8 | `revoked_at` | timestamptz | yes |  |
| 9 | `revoked_by` | uuid | yes |  |
| 10 | `created_by` | uuid | yes |  |
| 11 | `created_at` | timestamptz | NO | `now()` |
| 12 | `last_used_at` | timestamptz | yes |  |

**Primary key**

- `client_care_portals_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `client_care_portals_token_hash_key`: `UNIQUE (token_hash)`

**Foreign key (4)**

- `client_care_portals_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `client_care_portals_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `client_care_portals_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `client_care_portals_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES app_users(id)`

**Check (1)**

- `client_care_portals_token_hash_check`: `CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))`

**Indexes (2 besides the primary key)**

- `client_care_portals_client_idx`: `btree (organization_id, client_id) WHERE is_active`
- `client_care_portals_token_hash_key`: `UNIQUE btree (token_hash)`

### `care_requests`

A client/family request for care, with status, note, assigned caregiver/shift and authorization lineage.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient request; note entered through a public link (free text, unauthenticated source)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `client_id` | uuid | NO |  |
| 4 | `service_id` | uuid | NO |  |
| 5 | `portal_id` | uuid | yes |  |
| 6 | `authorization_lineage_id` | uuid | NO |  |
| 7 | `starts_at` | timestamptz | NO |  |
| 8 | `ends_at` | timestamptz | NO |  |
| 9 | `requested_minutes` | integer | NO |  |
| 10 | `status` | care_request_status | NO | `'requested'::care_request_status` |
| 11 | `note` | text | yes |  |
| 12 | `short_notice` | boolean | NO | `false` |
| 13 | `request_key` | uuid | NO |  |
| 14 | `assigned_shift_id` | uuid | yes |  |
| 15 | `assigned_caregiver_record_id` | uuid | yes |  |
| 16 | `created_at` | timestamptz | NO | `now()` |
| 17 | `updated_at` | timestamptz | NO | `now()` |
| 18 | `assigned_at` | timestamptz | yes |  |
| 19 | `cancelled_at` | timestamptz | yes |  |

**Primary key**

- `care_requests_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `care_requests_portal_id_request_key_key`: `UNIQUE (portal_id, request_key)`

**Foreign key (7)**

- `care_requests_assigned_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (assigned_caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `care_requests_assigned_shift_id_fkey`: `FOREIGN KEY (assigned_shift_id) REFERENCES shifts(id)`
- `care_requests_authorization_lineage_id_fkey`: `FOREIGN KEY (authorization_lineage_id) REFERENCES client_authorizations(id)`
- `care_requests_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `care_requests_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `care_requests_portal_id_fkey`: `FOREIGN KEY (portal_id) REFERENCES client_care_portals(id)`
- `care_requests_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (2)**

- `care_request_time_check`: `CHECK ((starts_at < ends_at))`
- `care_requests_requested_minutes_check`: `CHECK ((requested_minutes >= 180))`

**Indexes (2 besides the primary key)**

- `care_requests_portal_id_request_key_key`: `UNIQUE btree (portal_id, request_key)`
- `care_requests_queue_idx`: `btree (organization_id, status, starts_at)`

### `care_request_offers`

Offer of a request to a caregiver; offer link token stored as a hash; response status.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Credential-like (token hash); note (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `care_request_id` | uuid | NO |  |
| 4 | `caregiver_record_id` | uuid | NO |  |
| 5 | `token_hash` | text | NO |  |
| 6 | `status` | care_offer_status | NO | `'sent'::care_offer_status` |
| 7 | `note` | text | yes |  |
| 8 | `sent_at` | timestamptz | NO | `now()` |
| 9 | `responded_at` | timestamptz | yes |  |
| 10 | `updated_at` | timestamptz | NO | `now()` |

**Primary key**

- `care_request_offers_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `care_request_offers_care_request_id_caregiver_record_id_key`: `UNIQUE (care_request_id, caregiver_record_id)`
- `care_request_offers_token_hash_key`: `UNIQUE (token_hash)`

**Foreign key (3)**

- `care_request_offers_care_request_id_fkey`: `FOREIGN KEY (care_request_id) REFERENCES care_requests(id)`
- `care_request_offers_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `care_request_offers_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (1)**

- `care_request_offers_token_hash_check`: `CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))`

**Indexes (3 besides the primary key)**

- `care_request_offers_care_request_id_caregiver_record_id_key`: `UNIQUE btree (care_request_id, caregiver_record_id)`
- `care_request_offers_request_idx`: `btree (care_request_id, status)`
- `care_request_offers_token_hash_key`: `UNIQUE btree (token_hash)`

### `care_notifications`

In-app notification events for staff, portal or caregiver recipients.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Notification events

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `care_request_id` | uuid | NO |  |
| 4 | `recipient_type` | care_notification_recipient | NO |  |
| 5 | `recipient_user_id` | uuid | yes |  |
| 6 | `caregiver_record_id` | uuid | yes |  |
| 7 | `event_key` | text | NO |  |
| 8 | `read_at` | timestamptz | yes |  |
| 9 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `care_notifications_pkey`: `PRIMARY KEY (id)`

**Foreign key (4)**

- `care_notifications_care_request_id_fkey`: `FOREIGN KEY (care_request_id) REFERENCES care_requests(id)`
- `care_notifications_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `care_notifications_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `care_notifications_recipient_user_id_fkey`: `FOREIGN KEY (recipient_user_id) REFERENCES app_users(id)`

**Indexes (1 besides the primary key)**

- `care_notifications_staff_idx`: `btree (organization_id, recipient_user_id, read_at, created_at DESC)`

### `care_request_alert_recipients`

Staff members who are alerted about new care requests.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions (rows are also deleted by functions)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce identifiers

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `user_id` | uuid | NO |  |
| 3 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `care_request_alert_recipients_pkey`: `PRIMARY KEY (organization_id, user_id)`

**Foreign key (2)**

- `care_request_alert_recipients_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `care_request_alert_recipients_user_id_fkey`: `FOREIGN KEY (user_id) REFERENCES app_users(id)`

### `care_request_events`

Event history of a care request.

- **Domain:** Care requests and portals · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Event history; reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `care_request_id` | uuid | NO |  |
| 4 | `shift_id` | uuid | yes |  |
| 5 | `event_key` | text | NO |  |
| 6 | `actor_user_id` | uuid | yes |  |
| 7 | `reason` | text | yes |  |
| 8 | `before_snapshot` | jsonb | yes |  |
| 9 | `after_snapshot` | jsonb | yes |  |
| 10 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `care_request_events_pkey`: `PRIMARY KEY (id)`

**Foreign key (4)**

- `care_request_events_actor_user_id_fkey`: `FOREIGN KEY (actor_user_id) REFERENCES app_users(id)`
- `care_request_events_care_request_id_fkey`: `FOREIGN KEY (care_request_id) REFERENCES care_requests(id)`
- `care_request_events_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `care_request_events_shift_id_fkey`: `FOREIGN KEY (shift_id) REFERENCES shifts(id)`

**Indexes (1 besides the primary key)**

- `care_request_events_request_idx`: `btree (care_request_id, created_at)`

## Availability and readiness

### `caregiver_availability_windows`

Weekly availability windows of a caregiver (including overnight).

- **Domain:** Availability and readiness · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions (rows are also deleted by functions)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce availability

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `weekday` | smallint | yes |  |
| 5 | `specific_date` | date | yes |  |
| 6 | `start_local` | time without time zone | NO |  |
| 7 | `end_local` | time without time zone | NO |  |
| 8 | `created_at` | timestamptz | NO | `now()` |
| 9 | `request_id` | uuid | yes |  |

**Primary key**

- `caregiver_availability_windows_pkey`: `PRIMARY KEY (id)`

**Foreign key (3)**

- `caregiver_availability_window_caregiver_record_id_organiza_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_availability_windows_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_availability_windows_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES availability_requests(id)`

**Check (3)**

- `availability_time`: `CHECK ((start_local <> end_local))`
- `availability_weekday`: `CHECK (((weekday IS NULL) OR ((weekday >= 0) AND (weekday <= 6))))`
- `availability_window_shape`: `CHECK (((weekday IS NULL) <> (specific_date IS NULL)))`

**Indexes (2 besides the primary key)**

- `caregiver_availability_lookup_idx`: `btree (organization_id, caregiver_record_id, specific_date, weekday)`
- `caregiver_availability_request_idx`: `btree (request_id) WHERE (request_id IS NOT NULL)`

### `caregiver_unavailable_dates`

Specific dates a caregiver is unavailable.

- **Domain:** Availability and readiness · **Introduced:** migration 0011 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions (rows are also deleted by functions)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce availability; reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `caregiver_record_id` | uuid | NO |  |
| 3 | `unavailable_date` | date | NO |  |
| 4 | `reason` | text | yes |  |
| 5 | `created_at` | timestamptz | NO | `now()` |
| 6 | `id` | uuid | NO | `gen_random_uuid()` |
| 7 | `request_id` | uuid | yes |  |

**Primary key**

- `caregiver_unavailable_dates_pkey`: `PRIMARY KEY (id)`

**Foreign key (3)**

- `caregiver_unavailable_dates_caregiver_record_id_organizati_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_unavailable_dates_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_unavailable_dates_request_id_fkey`: `FOREIGN KEY (request_id) REFERENCES availability_requests(id)`

**Indexes (1 besides the primary key)**

- `caregiver_unavailable_one_per_layer`: `UNIQUE btree (organization_id, caregiver_record_id, unavailable_date, COALESCE(request_id, '00000000-0000-0000-0000-000000000000'::uuid))`

### `caregiver_availability_state`

One row per caregiver whose version counts approved changes (serialization point).

- **Domain:** Availability and readiness · **Introduced:** migration 0039 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce availability version

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `caregiver_record_id` | uuid | NO |  |
| 3 | `version` | integer | NO | `0` |
| 4 | `updated_at` | timestamptz | NO | `now()` |
| 5 | `updated_by` | uuid | yes |  |

**Primary key**

- `caregiver_availability_state_pkey`: `PRIMARY KEY (organization_id, caregiver_record_id)`

**Foreign key (3)**

- `caregiver_availability_state_caregiver_record_id_organizat_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_availability_state_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_availability_state_updated_by_fkey`: `FOREIGN KEY (updated_by) REFERENCES app_users(id)`

**Check (1)**

- `caregiver_availability_state_version_check`: `CHECK ((version >= 0))`

### `availability_requests`

Caregiver request to change availability, with review status and note.

- **Domain:** Availability and readiness · **Introduced:** migration 0039 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce availability; reason and review note (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `kind` | text | NO |  |
| 5 | `status` | availability_request_status | NO | `'pending'::availability_request_status` |
| 6 | `source` | text | NO | `'caregiver'::text` |
| 7 | `reason` | text | NO |  |
| 8 | `effective_from` | date | NO |  |
| 9 | `effective_until` | date | yes |  |
| 10 | `is_temporary` | boolean | NO | `false` |
| 11 | `windows` | jsonb | NO |  |
| 12 | `base_version` | integer | NO |  |
| 13 | `requested_by` | uuid | NO |  |
| 14 | `requested_at` | timestamptz | NO | `now()` |
| 15 | `reviewed_by` | uuid | yes |  |
| 16 | `reviewed_at` | timestamptz | yes |  |
| 17 | `review_note` | text | yes |  |
| 18 | `self_review` | boolean | NO | `false` |
| 19 | `approved_version` | integer | yes |  |

**Primary key**

- `availability_requests_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `availability_requests_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (4)**

- `availability_requests_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `availability_requests_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `availability_requests_requested_by_fkey`: `FOREIGN KEY (requested_by) REFERENCES app_users(id)`
- `availability_requests_reviewed_by_fkey`: `FOREIGN KEY (reviewed_by) REFERENCES app_users(id)`

**Check (7)**

- `availability_requests_base_version_check`: `CHECK ((base_version >= 0))`
- `availability_requests_decision`: `CHECK ((((status = 'pending'::availability_request_status) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (approved_version IS NULL)) OR ((status = 'approved'::availability_request_status) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (approved_version IS NOT NULL)) OR ((status = 'declined'::availability_request_status) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (length(btrim(COALESCE(review_note, ''::text))) >= 3)) OR ((status = ANY (ARRAY['withdrawn'::availability_request_status, 'superseded'::availability_request_status])) AND (reviewed_at IS NOT NULL))))`
- `availability_requests_kind_check`: `CHECK ((kind = ANY (ARRAY['weekly'::text, 'date'::text])))`
- `availability_requests_range`: `CHECK (((effective_until IS NULL) OR (effective_until >= effective_from)))`
- `availability_requests_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500)))`
- `availability_requests_source_check`: `CHECK ((source = ANY (ARRAY['caregiver'::text, 'administrator'::text])))`
- `availability_requests_temporary`: `CHECK ((((kind = 'date'::text) AND (effective_until = effective_from) AND is_temporary) OR ((kind = 'weekly'::text) AND (is_temporary = (effective_until IS NOT NULL)))))`

**Indexes (4 besides the primary key)**

- `availability_requests_caregiver_idx`: `btree (caregiver_record_id, requested_at DESC)`
- `availability_requests_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `availability_requests_one_pending`: `UNIQUE btree (caregiver_record_id, kind, (
CASE
    WHEN (kind = 'date'::text) THEN effective_from
    ELSE '0001-01-01'::date
END)) WHERE (status = 'pending'::availability_request_status)`
- `availability_requests_org_status_idx`: `btree (organization_id, status, requested_at DESC)`

### `availability_overrides`

One-shot administrator override of an availability check (caregiver, client, exact shift, reason, expiry, consumption).

- **Domain:** Availability and readiness · **Introduced:** migration 0042 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce and care-recipient linkage; reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `range_start` | timestamptz | NO |  |
| 5 | `range_end` | timestamptz | NO |  |
| 6 | `reason` | text | NO |  |
| 7 | `authorised_by` | uuid | NO |  |
| 8 | `created_at` | timestamptz | NO | `now()` |
| 9 | `expires_at` | timestamptz | NO |  |
| 10 | `used_count` | integer | NO | `0` |
| 11 | `last_used_at` | timestamptz | yes |  |
| 12 | `client_id` | uuid | yes |  |
| 13 | `original_status` | text | yes |  |
| 14 | `consumed_at` | timestamptz | yes |  |
| 15 | `consumed_context` | text | yes |  |
| 16 | `shift_id` | uuid | yes |  |

**Primary key**

- `availability_overrides_pkey`: `PRIMARY KEY (id)`

**Foreign key (5)**

- `availability_overrides_authorised_by_fkey`: `FOREIGN KEY (authorised_by) REFERENCES app_users(id)`
- `availability_overrides_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `availability_overrides_client_fk`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `availability_overrides_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `availability_overrides_shift_id_fkey`: `FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL`

**Check (5)**

- `availability_overrides_consumed_shape`: `CHECK (((consumed_at IS NOT NULL) OR (shift_id IS NULL)))`
- `availability_overrides_one_shift`: `CHECK (((client_id IS NULL) OR ((range_end - range_start) <= '24:00:00'::interval)))`
- `availability_overrides_original_status`: `CHECK (((original_status IS NULL) OR (original_status = ANY (ARRAY['outside'::text, 'not_provided'::text]))))`
- `availability_overrides_range`: `CHECK (((range_end > range_start) AND ((range_end - range_start) <= '400 days'::interval)))`
- `availability_overrides_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500)))`

**Indexes (2 besides the primary key)**

- `availability_overrides_lookup_idx`: `btree (caregiver_record_id, expires_at)`
- `availability_overrides_shift_idx`: `btree (shift_id) WHERE (shift_id IS NOT NULL)`

### `caregiver_service_approvals`

Per-caregiver approval to deliver a service, with approval and revocation reasons.

- **Domain:** Availability and readiness · **Introduced:** migration 0040 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce qualification data; reasons (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `service_id` | uuid | NO |  |
| 5 | `effective_from` | date | NO |  |
| 6 | `effective_until` | date | yes |  |
| 7 | `approval_reason` | text | NO |  |
| 8 | `source` | text | NO | `'administrator'::text` |
| 9 | `review_batch_id` | uuid | yes |  |
| 10 | `approved_by` | uuid | NO |  |
| 11 | `approved_at` | timestamptz | NO | `now()` |
| 12 | `revoked_at` | timestamptz | yes |  |
| 13 | `revoked_by` | uuid | yes |  |
| 14 | `revoked_effective_on` | date | yes |  |
| 15 | `revocation_reason` | text | yes |  |

**Primary key**

- `caregiver_service_approvals_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `caregiver_service_approvals_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (5)**

- `caregiver_service_approvals_approved_by_fkey`: `FOREIGN KEY (approved_by) REFERENCES app_users(id)`
- `caregiver_service_approvals_caregiver_record_id_organizati_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_service_approvals_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_service_approvals_revoked_by_fkey`: `FOREIGN KEY (revoked_by) REFERENCES app_users(id)`
- `caregiver_service_approvals_service_id_organization_id_fkey`: `FOREIGN KEY (service_id, organization_id) REFERENCES services(id, organization_id)`

**Check (4)**

- `caregiver_service_approvals_approval_reason_check`: `CHECK (((length(btrim(approval_reason)) >= 3) AND (length(btrim(approval_reason)) <= 500)))`
- `caregiver_service_approvals_range`: `CHECK (((effective_until IS NULL) OR (effective_until >= effective_from)))`
- `caregiver_service_approvals_revocation`: `CHECK ((((revoked_at IS NULL) AND (revoked_by IS NULL) AND (revoked_effective_on IS NULL) AND (revocation_reason IS NULL)) OR ((revoked_at IS NOT NULL) AND (revoked_by IS NOT NULL) AND (revoked_effective_on IS NOT NULL) AND (length(btrim(COALESCE(revocation_reason, ''::text))) >= 3))))`
- `caregiver_service_approvals_source_check`: `CHECK ((source = ANY (ARRAY['administrator'::text, 'bulk_review'::text])))`

**Indexes (3 besides the primary key)**

- `caregiver_service_approvals_batch_idx`: `btree (review_batch_id) WHERE (review_batch_id IS NOT NULL)`
- `caregiver_service_approvals_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `caregiver_service_approvals_pair_idx`: `btree (organization_id, caregiver_record_id, service_id)`

### `shift_readiness_flags`

Open flags on future shifts put at risk by readiness changes.

- **Domain:** Availability and readiness · **Introduced:** migration 0039 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce readiness

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `shift_id` | uuid | NO |  |
| 4 | `caregiver_record_id` | uuid | NO |  |
| 5 | `kind` | text | NO |  |
| 6 | `reason_code` | text | NO |  |
| 7 | `detail` | jsonb | NO | `'{}'::jsonb` |
| 8 | `cause_id` | uuid | yes |  |
| 9 | `created_at` | timestamptz | NO | `now()` |
| 10 | `resolved_at` | timestamptz | yes |  |
| 11 | `resolved_by` | uuid | yes |  |
| 12 | `resolution` | text | yes |  |

**Primary key**

- `shift_readiness_flags_pkey`: `PRIMARY KEY (id)`

**Foreign key (4)**

- `shift_readiness_flags_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `shift_readiness_flags_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `shift_readiness_flags_resolved_by_fkey`: `FOREIGN KEY (resolved_by) REFERENCES app_users(id)`
- `shift_readiness_flags_shift_id_fkey`: `FOREIGN KEY (shift_id) REFERENCES shifts(id)`

**Check (1)**

- `shift_readiness_flags_kind_check`: `CHECK ((kind = ANY (ARRAY['availability'::text, 'service'::text, 'document'::text])))`

**Indexes (2 besides the primary key)**

- `shift_readiness_flags_one_open`: `UNIQUE btree (shift_id, kind) WHERE (resolved_at IS NULL)`
- `shift_readiness_flags_org_open_idx`: `btree (organization_id, kind) WHERE (resolved_at IS NULL)`

### `assignment_readiness_flags`

Standing assignments that lost approval or a required document.

- **Domain:** Availability and readiness · **Introduced:** migration 0040 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce readiness

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `assignment_id` | uuid | NO |  |
| 4 | `caregiver_record_id` | uuid | NO |  |
| 5 | `kind` | text | NO |  |
| 6 | `reason_code` | text | NO |  |
| 7 | `detail` | jsonb | NO | `'{}'::jsonb` |
| 8 | `cause_id` | uuid | yes |  |
| 9 | `created_at` | timestamptz | NO | `now()` |
| 10 | `resolved_at` | timestamptz | yes |  |
| 11 | `resolved_by` | uuid | yes |  |
| 12 | `resolution` | text | yes |  |

**Primary key**

- `assignment_readiness_flags_pkey`: `PRIMARY KEY (id)`

**Foreign key (4)**

- `assignment_readiness_flags_assignment_id_fkey`: `FOREIGN KEY (assignment_id) REFERENCES caregiver_assignments(id)`
- `assignment_readiness_flags_caregiver_record_id_organizatio_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `assignment_readiness_flags_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `assignment_readiness_flags_resolved_by_fkey`: `FOREIGN KEY (resolved_by) REFERENCES app_users(id)`

**Check (1)**

- `assignment_readiness_flags_kind_check`: `CHECK ((kind = ANY (ARRAY['service'::text, 'document'::text])))`

**Indexes (2 besides the primary key)**

- `assignment_readiness_flags_one_open`: `UNIQUE btree (assignment_id, kind) WHERE (resolved_at IS NULL)`
- `assignment_readiness_flags_org_open_idx`: `btree (organization_id, kind) WHERE (resolved_at IS NULL)`

### `organization_readiness_settings`

Per-agency readiness mode (report-only/enforced) and service-check switch.

- **Domain:** Availability and readiness · **Introduced:** migration 0042 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `enforcement_active_from` | timestamptz | yes |  |
| 3 | `enforcement_activated_by` | uuid | yes |  |
| 4 | `service_checks` | boolean | NO | `false` |
| 5 | `updated_at` | timestamptz | NO | `now()` |
| 6 | `updated_by` | uuid | yes |  |

**Primary key**

- `organization_readiness_settings_pkey`: `PRIMARY KEY (organization_id)`

**Foreign key (3)**

- `organization_readiness_settings_enforcement_activated_by_fkey`: `FOREIGN KEY (enforcement_activated_by) REFERENCES app_users(id)`
- `organization_readiness_settings_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `organization_readiness_settings_updated_by_fkey`: `FOREIGN KEY (updated_by) REFERENCES app_users(id)`

### `readiness_setting_events`

History of changes to readiness settings.

- **Domain:** Availability and readiness · **Introduced:** migration 0042 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `setting` | text | NO |  |
| 4 | `old_value` | text | yes |  |
| 5 | `new_value` | text | NO |  |
| 6 | `reason` | text | NO |  |
| 7 | `report` | jsonb | yes |  |
| 8 | `changed_by` | uuid | NO |  |
| 9 | `changed_at` | timestamptz | NO | `now()` |

**Primary key**

- `readiness_setting_events_pkey`: `PRIMARY KEY (id)`

**Foreign key (2)**

- `readiness_setting_events_changed_by_fkey`: `FOREIGN KEY (changed_by) REFERENCES app_users(id)`
- `readiness_setting_events_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (2)**

- `readiness_setting_events_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500)))`
- `readiness_setting_events_setting_check`: `CHECK ((setting = ANY (ARRAY['enforcement'::text, 'service_checks'::text])))`

## Staff documents

### `document_types`

Agency catalogue of staff document types (for example CPR, TB).

- **Domain:** Staff documents · **Introduced:** migration 0021 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `name` | text | NO |  |
| 4 | `requires_expiry` | boolean | NO | `false` |
| 5 | `is_active` | boolean | NO | `true` |
| 6 | `created_by` | uuid | NO |  |
| 7 | `created_at` | timestamptz | NO | `now()` |
| 8 | `reminder_days` | integer[] | yes |  |
| 9 | `work_requirement` | text | yes |  |

**Primary key**

- `document_types_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `document_types_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (2)**

- `document_types_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `document_types_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (3)**

- `document_types_name_check`: `CHECK (((length(btrim(name)) >= 2) AND (length(btrim(name)) <= 80)))`
- `document_types_reminder_days_valid`: `CHECK (((reminder_days IS NULL) OR COALESCE(valid_reminder_days(reminder_days), false)))`
- `document_types_work_requirement_check`: `CHECK ((work_requirement = ANY (ARRAY['cpr'::text, 'tb'::text])))`

**Indexes (3 besides the primary key)**

- `document_types_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `document_types_one_work_requirement`: `UNIQUE btree (organization_id, work_requirement) WHERE (work_requirement IS NOT NULL)`
- `document_types_org_name_unique`: `UNIQUE btree (organization_id, lower(btrim(name)))`

### `staff_documents`

A requested/held document slot for a caregiver and type, with due date and closure.

- **Domain:** Staff documents · **Introduced:** migration 0021 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; updates only through functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce documents (for example CPR, TB: health-related)
- **Triggers:** `staff_documents_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `caregiver_record_id` | uuid | NO |  |
| 4 | `document_type_id` | uuid | NO |  |
| 5 | `due_on` | date | yes |  |
| 6 | `requested_by` | uuid | NO |  |
| 7 | `requested_at` | timestamptz | NO | `now()` |
| 8 | `closed_at` | timestamptz | yes |  |

**Primary key**

- `staff_documents_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `staff_documents_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (4)**

- `staff_documents_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `staff_documents_document_type_id_organization_id_fkey`: `FOREIGN KEY (document_type_id, organization_id) REFERENCES document_types(id, organization_id)`
- `staff_documents_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `staff_documents_requested_by_fkey`: `FOREIGN KEY (requested_by) REFERENCES app_users(id)`

**Indexes (3 besides the primary key)**

- `staff_documents_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `staff_documents_one_open`: `UNIQUE btree (caregiver_record_id, document_type_id) WHERE (closed_at IS NULL)`
- `staff_documents_org_idx`: `btree (organization_id)`

### `document_versions`

Uploaded versions of a staff document (S3 key, hash, issue/expiry, review status). Versions are kept.

- **Domain:** Staff documents · **Introduced:** migration 0021 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** DELETE blocked; guarded updates only (trigger)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce documents; S3 key, hash, expiry; rejection reason (free text)
- **Triggers:** `document_versions_guard_update` (`document_versions_guard_update`), `document_versions_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `document_id` | uuid | NO |  |
| 4 | `version_number` | integer | NO |  |
| 5 | `object_key` | text | NO |  |
| 6 | `s3_version_id` | text | yes |  |
| 7 | `content_type` | text | NO |  |
| 8 | `byte_size` | integer | NO |  |
| 9 | `sha256` | text | NO |  |
| 10 | `issued_on` | date | yes |  |
| 11 | `expires_on` | date | yes |  |
| 12 | `uploaded_by` | uuid | NO |  |
| 13 | `uploaded_at` | timestamptz | NO | `now()` |
| 14 | `review_status` | document_review_status | NO | `'awaiting_review'::document_review_status` |
| 15 | `reviewed_by` | uuid | yes |  |
| 16 | `reviewed_at` | timestamptz | yes |  |
| 17 | `rejection_reason` | text | yes |  |

**Primary key**

- `document_versions_pkey`: `PRIMARY KEY (id)`

**Unique (2)**

- `document_versions_document_id_version_number_key`: `UNIQUE (document_id, version_number)`
- `document_versions_object_key_key`: `UNIQUE (object_key)`

**Foreign key (4)**

- `document_versions_document_id_organization_id_fkey`: `FOREIGN KEY (document_id, organization_id) REFERENCES staff_documents(id, organization_id)`
- `document_versions_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `document_versions_reviewed_by_fkey`: `FOREIGN KEY (reviewed_by) REFERENCES app_users(id)`
- `document_versions_uploaded_by_fkey`: `FOREIGN KEY (uploaded_by) REFERENCES app_users(id)`

**Check (6)**

- `document_versions_byte_size_check`: `CHECK (((byte_size >= 1) AND (byte_size <= 4000000)))`
- `document_versions_content_type_check`: `CHECK ((content_type = ANY (ARRAY['application/pdf'::text, 'image/jpeg'::text, 'image/png'::text])))`
- `document_versions_dates`: `CHECK (((expires_on IS NULL) OR (issued_on IS NULL) OR (expires_on > issued_on)))`
- `document_versions_review_shape`: `CHECK ((((review_status = 'awaiting_review'::document_review_status) AND (reviewed_by IS NULL) AND (reviewed_at IS NULL) AND (rejection_reason IS NULL)) OR ((review_status = 'verified'::document_review_status) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (rejection_reason IS NULL)) OR ((review_status = 'rejected'::document_review_status) AND (reviewed_by IS NOT NULL) AND (reviewed_at IS NOT NULL) AND (length(btrim(COALESCE(rejection_reason, ''::text))) > 0))))`
- `document_versions_sha256_check`: `CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text))`
- `document_versions_version_number_check`: `CHECK ((version_number >= 1))`

**Indexes (2 besides the primary key)**

- `document_versions_document_id_version_number_key`: `UNIQUE btree (document_id, version_number)`
- `document_versions_object_key_key`: `UNIQUE btree (object_key)`

### `document_requirement_policies`

Agency rule on which documents are required and how.

- **Domain:** Staff documents · **Introduced:** migration 0041 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `requirement` | text | NO |  |
| 3 | `validity_basis` | text | NO |  |
| 4 | `validity_days` | integer | yes |  |
| 5 | `reason` | text | NO |  |
| 6 | `configured_by` | uuid | NO |  |
| 7 | `configured_at` | timestamptz | NO | `now()` |

**Primary key**

- `document_requirement_policies_pkey`: `PRIMARY KEY (organization_id, requirement)`

**Foreign key (2)**

- `document_requirement_policies_configured_by_fkey`: `FOREIGN KEY (configured_by) REFERENCES app_users(id)`
- `document_requirement_policies_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (5)**

- `document_requirement_policies_days`: `CHECK (((validity_basis = 'issue_plus_days'::text) = (validity_days IS NOT NULL)))`
- `document_requirement_policies_reason_check`: `CHECK (((length(btrim(reason)) >= 3) AND (length(btrim(reason)) <= 500)))`
- `document_requirement_policies_requirement_check`: `CHECK ((requirement = ANY (ARRAY['cpr'::text, 'tb'::text])))`
- `document_requirement_policies_validity_basis_check`: `CHECK ((validity_basis = ANY (ARRAY['document_expiry'::text, 'issue_plus_days'::text])))`
- `document_requirement_policies_validity_days_check`: `CHECK (((validity_days >= 1) AND (validity_days <= 3650)))`

### `document_requirement_policy_history`

Archived previous policy rows.

- **Domain:** Staff documents · **Introduced:** migration 0041 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Reason (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `requirement` | text | NO |  |
| 4 | `validity_basis` | text | NO |  |
| 5 | `validity_days` | integer | yes |  |
| 6 | `reason` | text | NO |  |
| 7 | `configured_by` | uuid | NO |  |
| 8 | `configured_at` | timestamptz | NO |  |
| 9 | `replaced_at` | timestamptz | NO | `now()` |

**Primary key**

- `document_requirement_policy_history_pkey`: `PRIMARY KEY (id)`

**Foreign key (2)**

- `document_requirement_policy_history_configured_by_fkey`: `FOREIGN KEY (configured_by) REFERENCES app_users(id)`
- `document_requirement_policy_history_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

## Matching inputs

### `scoring_rule_versions`

Versioned matching rule (weights and parameters); global reference data.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** none (global/identity table)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `version` | text | NO |  |
| 2 | `status` | text | NO |  |
| 3 | `weights` | jsonb | NO |  |
| 4 | `parameters` | jsonb | NO |  |
| 5 | `description` | text | NO |  |
| 6 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `scoring_rule_versions_pkey`: `PRIMARY KEY (version)`

**Check (1)**

- `scoring_rule_versions_status_check`: `CHECK ((status = ANY (ARRAY['provisional'::text, 'approved'::text, 'retired'::text])))`

### `experience_tags`

Agency catalogue of experience tags.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | uuid | NO | `gen_random_uuid()` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `label` | text | NO |  |
| 4 | `is_active` | boolean | NO | `true` |
| 5 | `created_by` | uuid | NO |  |
| 6 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `experience_tags_pkey`: `PRIMARY KEY (id)`

**Unique (1)**

- `experience_tags_id_organization_id_key`: `UNIQUE (id, organization_id)`

**Foreign key (2)**

- `experience_tags_created_by_fkey`: `FOREIGN KEY (created_by) REFERENCES app_users(id)`
- `experience_tags_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Check (1)**

- `experience_tags_label_check`: `CHECK (((length(btrim(label)) >= 2) AND (length(btrim(label)) <= 60)))`

**Indexes (2 besides the primary key)**

- `experience_tags_id_organization_id_key`: `UNIQUE btree (id, organization_id)`
- `experience_tags_org_label`: `UNIQUE btree (organization_id, lower(btrim(label)))`

### `caregiver_experience`

Experience a caregiver reported, with administrator confirmation status.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions (rows are also deleted by functions)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Workforce qualification data

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `caregiver_record_id` | uuid | NO |  |
| 3 | `tag_id` | uuid | NO |  |
| 4 | `status` | text | NO |  |
| 5 | `reported_by` | uuid | yes |  |
| 6 | `reported_at` | timestamptz | yes |  |
| 7 | `reviewed_by` | uuid | yes |  |
| 8 | `reviewed_at` | timestamptz | yes |  |

**Primary key**

- `caregiver_experience_pkey`: `PRIMARY KEY (caregiver_record_id, tag_id)`

**Foreign key (5)**

- `caregiver_experience_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_experience_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_experience_reported_by_fkey`: `FOREIGN KEY (reported_by) REFERENCES app_users(id)`
- `caregiver_experience_reviewed_by_fkey`: `FOREIGN KEY (reviewed_by) REFERENCES app_users(id)`
- `caregiver_experience_tag_id_organization_id_fkey`: `FOREIGN KEY (tag_id, organization_id) REFERENCES experience_tags(id, organization_id)`

**Check (2)**

- `caregiver_experience_review_shape`: `CHECK (((status = 'reported'::text) = (reviewed_at IS NULL)))`
- `caregiver_experience_status_check`: `CHECK ((status = ANY (ARRAY['reported'::text, 'confirmed'::text, 'not_confirmed'::text])))`

### `caregiver_experience_reviews`

Record that an administrator reviewed a caregiver's experience.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Review note (free text)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `caregiver_record_id` | uuid | NO |  |
| 3 | `reviewed_by` | uuid | NO |  |
| 4 | `reviewed_at` | timestamptz | NO | `now()` |
| 5 | `note` | text | yes |  |

**Primary key**

- `caregiver_experience_reviews_pkey`: `PRIMARY KEY (caregiver_record_id)`

**Foreign key (3)**

- `caregiver_experience_reviews_caregiver_record_id_organizat_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_experience_reviews_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_experience_reviews_reviewed_by_fkey`: `FOREIGN KEY (reviewed_by) REFERENCES app_users(id)`

### `client_experience_requirements`

Experience a client wants or requires (preferred/mandatory).

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions (rows are also deleted by functions)
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Care-recipient needs/preferences

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `client_id` | uuid | NO |  |
| 3 | `tag_id` | uuid | NO |  |
| 4 | `mandatory` | boolean | NO | `false` |
| 5 | `set_by` | uuid | NO |  |
| 6 | `set_at` | timestamptz | NO | `now()` |

**Primary key**

- `client_experience_requirements_pkey`: `PRIMARY KEY (client_id, tag_id)`

**Foreign key (4)**

- `client_experience_requirements_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `client_experience_requirements_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `client_experience_requirements_set_by_fkey`: `FOREIGN KEY (set_by) REFERENCES app_users(id)`
- `client_experience_requirements_tag_id_organization_id_fkey`: `FOREIGN KEY (tag_id, organization_id) REFERENCES experience_tags(id, organization_id)`

### `caregiver_zip`

Caregiver 5-digit ZIP (no address), administrators only.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, no policy; not forced · **`ogevia_readonly` grant:** none
- **Sensitivity (analysis):** Workforce location (5-digit ZIP)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `caregiver_record_id` | uuid | NO |  |
| 3 | `zip` | text | NO |  |
| 4 | `set_by` | uuid | NO |  |
| 5 | `set_at` | timestamptz | NO | `now()` |

**Primary key**

- `caregiver_zip_pkey`: `PRIMARY KEY (caregiver_record_id)`

**Foreign key (3)**

- `caregiver_zip_caregiver_record_id_organization_id_fkey`: `FOREIGN KEY (caregiver_record_id, organization_id) REFERENCES caregiver_records(id, organization_id)`
- `caregiver_zip_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `caregiver_zip_set_by_fkey`: `FOREIGN KEY (set_by) REFERENCES app_users(id)`

**Check (1)**

- `caregiver_zip_zip_check`: `CHECK ((zip ~ '^[0-9]{5}$'::text))`

### `client_service_zip`

Client service-location 5-digit ZIP (no address).

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, no policy; not forced · **`ogevia_readonly` grant:** none
- **Sensitivity (analysis):** Care-recipient location (5-digit ZIP)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `organization_id` | uuid | NO |  |
| 2 | `client_id` | uuid | NO |  |
| 3 | `zip` | text | NO |  |
| 4 | `set_by` | uuid | NO |  |
| 5 | `set_at` | timestamptz | NO | `now()` |

**Primary key**

- `client_service_zip_pkey`: `PRIMARY KEY (client_id)`

**Foreign key (3)**

- `client_service_zip_client_id_organization_id_fkey`: `FOREIGN KEY (client_id, organization_id) REFERENCES clients(id, organization_id)`
- `client_service_zip_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`
- `client_service_zip_set_by_fkey`: `FOREIGN KEY (set_by) REFERENCES app_users(id)`

**Check (1)**

- `client_service_zip_zip_check`: `CHECK ((zip ~ '^[0-9]{5}$'::text))`

### `zip_centroids`

Shared ZIP centroid reference data; empty until a dataset with recorded source, licence and vintage is loaded.

- **Domain:** Matching inputs · **Introduced:** migration 0043 · **Tenant key:** none (global/identity table)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** None (public reference data)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `zip` | text | NO |  |
| 2 | `lat` | numeric(9,6) | NO |  |
| 3 | `lon` | numeric(9,6) | NO |  |
| 4 | `source` | text | NO |  |
| 5 | `licence` | text | NO |  |
| 6 | `vintage` | text | NO |  |
| 7 | `loaded_at` | timestamptz | NO | `now()` |

**Primary key**

- `zip_centroids_pkey`: `PRIMARY KEY (zip)`

**Check (6)**

- `zip_centroids_lat_check`: `CHECK (((lat >= ('-90'::integer)::numeric) AND (lat <= (90)::numeric)))`
- `zip_centroids_licence_check`: `CHECK ((length(btrim(licence)) >= 3))`
- `zip_centroids_lon_check`: `CHECK (((lon >= ('-180'::integer)::numeric) AND (lon <= (180)::numeric)))`
- `zip_centroids_source_check`: `CHECK ((length(btrim(source)) >= 3))`
- `zip_centroids_vintage_check`: `CHECK ((length(btrim(vintage)) >= 2))`
- `zip_centroids_zip_check`: `CHECK ((zip ~ '^[0-9]{5}$'::text))`

## Audit and idempotency

### `audit_events`

Append-only audit trail (ids, statuses, minutes, timestamps; no names or notes by design).

- **Domain:** Audit and idempotency · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Append-only: UPDATE and DELETE blocked by trigger
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Ids/statuses/minutes by design; `reason` is free text
- **Triggers:** `audit_events_append_only` (`forbid_update`), `audit_events_no_delete` (`forbid_delete`)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `id` | bigint | NO | `identity (always)` |
| 2 | `organization_id` | uuid | NO |  |
| 3 | `actor_user_id` | uuid | yes |  |
| 4 | `action` | text | NO |  |
| 5 | `entity_type` | text | NO |  |
| 6 | `entity_id` | uuid | yes |  |
| 7 | `request_id` | uuid | yes |  |
| 8 | `reason` | text | yes |  |
| 9 | `before_state` | jsonb | yes |  |
| 10 | `after_state` | jsonb | yes |  |
| 11 | `occurred_at` | timestamptz | NO | `now()` |

**Primary key**

- `audit_events_pkey`: `PRIMARY KEY (id)`

**Foreign key (2)**

- `audit_events_actor_user_id_fkey`: `FOREIGN KEY (actor_user_id) REFERENCES app_users(id)`
- `audit_events_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Indexes (2 besides the primary key)**

- `audit_events_entity_idx`: `btree (entity_type, entity_id)`
- `audit_events_org_time_idx`: `btree (organization_id, occurred_at DESC)`

### `idempotency_records`

Stored responses keyed by actor, operation and idempotency key so a retry returns the first result.

- **Domain:** Audit and idempotency · **Introduced:** migration 0005 · **Tenant key:** `organization_id` (NOT NULL, FK to `organizations`)
- **Lifecycle:** Mutable through `ogevia_api` functions
- **Row level security:** enabled, 1 policy (SELECT for `ogevia_readonly`); not forced · **`ogevia_readonly` grant:** SELECT
- **Sensitivity (analysis):** Stored API responses (may include visit identifiers and minutes)

| # | Column | Type | Null | Default |
|---|---|---|---|---|
| 1 | `actor_user_id` | uuid | NO |  |
| 2 | `operation` | text | NO |  |
| 3 | `idempotency_key` | uuid | NO |  |
| 4 | `organization_id` | uuid | NO |  |
| 5 | `request_fingerprint` | text | NO |  |
| 6 | `response` | jsonb | NO |  |
| 7 | `created_at` | timestamptz | NO | `now()` |

**Primary key**

- `idempotency_records_pkey`: `PRIMARY KEY (actor_user_id, operation, idempotency_key)`

**Foreign key (2)**

- `idempotency_records_actor_user_id_fkey`: `FOREIGN KEY (actor_user_id) REFERENCES app_users(id)`
- `idempotency_records_organization_id_fkey`: `FOREIGN KEY (organization_id) REFERENCES organizations(id)`

**Indexes (1 besides the primary key)**

- `idempotency_records_created_idx`: `btree (created_at)`

