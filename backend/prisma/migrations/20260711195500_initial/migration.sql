-- CreateTable
CREATE TABLE "companies" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_sources" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_key" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "service_type" TEXT NOT NULL,
    "configured_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "credential_reference" TEXT,
    "connection_status" TEXT NOT NULL DEFAULT 'setup_required',
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_sync_at" TIMESTAMP(3),
    "last_sync_status" TEXT,
    "last_error_code" TEXT,
    "sync_cursor" TEXT,
    "sync_page_token" TEXT,
    "last_full_sync_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connector_credentials" (
    "source_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encrypted_payload" TEXT NOT NULL,
    "iv" TEXT NOT NULL,
    "auth_tag" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "connector_credentials_pkey" PRIMARY KEY ("source_id")
);

-- CreateTable
CREATE TABLE "connector_oauth_states" (
    "id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "state_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connector_oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'worker',
    "permissions" TEXT[],
    "skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weekly_capacity_hours" INTEGER NOT NULL DEFAULT 40,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "clients" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "first_name" TEXT,
    "last_name" TEXT,
    "company_name" TEXT,
    "email_primary" TEXT,
    "phone_primary" TEXT,
    "client_type" TEXT,
    "billing_address_line1" TEXT,
    "billing_city" TEXT,
    "billing_postcode" TEXT,
    "notes" TEXT,
    "source" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "job_title" TEXT NOT NULL,
    "job_status" TEXT NOT NULL DEFAULT 'nova',
    "property_address" TEXT,
    "assigned_user_id" TEXT,
    "estimated_duration_hours" DOUBLE PRECISION,
    "required_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "service_catalogue_item_id" TEXT,
    "planned_start_at" TIMESTAMP(3),
    "planned_end_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "display_name" TEXT NOT NULL,
    "job_title" TEXT,
    "department" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "preferred_channel" TEXT,
    "preferred_language" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "source_reference" TEXT,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_contacts" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_source_id" TEXT NOT NULL,
    "external_resource_name" TEXT NOT NULL,
    "source_etag" TEXT,
    "display_name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "organisation" TEXT,
    "job_title" TEXT,
    "department" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "imported_contact_id" TEXT,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_calendars" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_source_id" TEXT NOT NULL,
    "external_calendar_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "description" TEXT,
    "time_zone" TEXT,
    "access_role" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "event_sync_token" TEXT,
    "event_page_token" TEXT,
    "last_event_sync_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_calendars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_calendar_events" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_source_id" TEXT NOT NULL,
    "external_calendar_record_id" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "source_etag" TEXT,
    "status" TEXT,
    "summary" TEXT,
    "description" TEXT,
    "location" TEXT,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "start_date" TEXT,
    "end_date" TEXT,
    "time_zone" TEXT,
    "organiser_email" TEXT,
    "attendee_emails" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "transparency" TEXT,
    "visibility" TEXT,
    "recurring_event_id" TEXT,
    "html_link" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_calendar_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_drive_images" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "connector_source_id" TEXT NOT NULL,
    "external_file_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "web_view_link" TEXT,
    "thumbnail_link" TEXT,
    "parent_ids" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "size_bytes" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "created_time" TIMESTAMP(3),
    "modified_time" TIMESTAMP(3),
    "portfolio_photo_id" TEXT,
    "is_removed" BOOLEAN NOT NULL DEFAULT false,
    "staged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_drive_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "document_records" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "job_id" TEXT,
    "title" TEXT NOT NULL,
    "document_type" TEXT NOT NULL,
    "document_reference" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "sensitivity" TEXT NOT NULL DEFAULT 'normal',
    "verification_status" TEXT NOT NULL DEFAULT 'user_entered',
    "issued_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "service_requested" TEXT,
    "location" TEXT,
    "source" TEXT,
    "urgency" TEXT,
    "lead_status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "converted_client_id" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_catalogue_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT,
    "base_price_min" DOUBLE PRECISION,
    "base_price_max" DOUBLE PRECISION,
    "price_unit" TEXT,
    "default_duration_hours" DOUBLE PRECISION,
    "default_required_skills" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "source_reference" TEXT,
    "reference_activity_code" TEXT,
    "reference_industry_code" TEXT,
    "reference_subtype_code" TEXT,
    "reference_pricing_method" TEXT,
    "reference_rate_unit" TEXT,
    "reference_rate_gbp" DOUBLE PRECISION,
    "reference_pricing_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "service_catalogue_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "job_id" TEXT,
    "title" TEXT NOT NULL,
    "quote_status" TEXT NOT NULL DEFAULT 'draft',
    "notes" TEXT,
    "valid_until" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "service_catalogue_item_id" TEXT,
    "description" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit_price" DOUBLE PRECISION NOT NULL,
    "unit_cost" DOUBLE PRECISION,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_openings" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT,
    "urgency" TEXT NOT NULL DEFAULT 'medium',
    "opening_status" TEXT NOT NULL DEFAULT 'draft',
    "skills_required" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expected_tasks" TEXT,
    "min_experience_years" DOUBLE PRECISION,
    "preferred_experience_years" DOUBLE PRECISION,
    "language_requirements" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "availability_requirements" TEXT,
    "description" TEXT,
    "draft_advert_text" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_openings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "candidates" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "job_opening_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbooks" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "step_templates" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "playbooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "playbook_runs" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "playbook_id" TEXT NOT NULL,
    "triggered_by" TEXT,
    "variables" JSONB,
    "stepResults" JSONB NOT NULL,
    "overall_ok" BOOLEAN NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playbook_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "learning_rules" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "term" TEXT NOT NULL,
    "meaning" TEXT NOT NULL,
    "alias_for" TEXT,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "learning_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_records" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "job_id" TEXT,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "full_text" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "follow_up_needed" BOOLEAN NOT NULL DEFAULT false,
    "follow_up_due_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_intakes" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "communication_record_id" TEXT,
    "connector_source_id" TEXT,
    "external_message_id" TEXT,
    "external_thread_id" TEXT,
    "channel" TEXT NOT NULL,
    "sender_name" TEXT,
    "sender_email" TEXT,
    "sender_phone" TEXT,
    "message_text" TEXT NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL,
    "source_reference" TEXT,
    "intake_status" TEXT NOT NULL DEFAULT 'new',
    "resolution_needed" BOOLEAN NOT NULL DEFAULT true,
    "resolved_at" TIMESTAMP(3),
    "resolved_by" TEXT,
    "extracted_data" JSONB,
    "reply_draft" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "communication_intakes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "job_id" TEXT,
    "communication_record_id" TEXT,
    "assigned_user_id" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "task_status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "category" TEXT NOT NULL DEFAULT 'administrative',
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "due_at" TIMESTAMP(3),
    "estimated_duration_hours" DOUBLE PRECISION,
    "completed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_acknowledgements" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "notification_key" TEXT NOT NULL,
    "acknowledged_by" TEXT,
    "acknowledged_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "portfolio_photos" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "client_id" TEXT,
    "job_id" TEXT,
    "filename" TEXT NOT NULL,
    "caption" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "taken_at" TIMESTAMP(3),
    "source" TEXT NOT NULL,
    "usable_for_marketing" BOOLEAN NOT NULL DEFAULT false,
    "usable_for_marketing_notes" TEXT,
    "quality_review_status" TEXT NOT NULL DEFAULT 'unreviewed',
    "duplicate_review_status" TEXT NOT NULL DEFAULT 'unreviewed',
    "sensitive_data_review_status" TEXT NOT NULL DEFAULT 'unreviewed',
    "usage_permission_status" TEXT NOT NULL DEFAULT 'unknown',
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "portfolio_photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_service_selections" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "service_catalogue_item_id" TEXT NOT NULL,
    "portfolio_photo_id" TEXT NOT NULL,
    "is_selected" BOOLEAN NOT NULL DEFAULT true,
    "own_production_required" BOOLEAN NOT NULL DEFAULT true,
    "review_notes" TEXT,
    "evidence_snapshot" JSONB NOT NULL,
    "selected_by" TEXT,
    "selected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photo_service_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "business_context_items" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "verification_status" TEXT NOT NULL DEFAULT 'user_entered',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_context_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industries" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'user_input',
    "verification_status" TEXT NOT NULL DEFAULT 'user_entered',
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "industry_service_links" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "industry_id" TEXT NOT NULL,
    "service_catalogue_item_id" TEXT NOT NULL,
    "notes" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "industry_service_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_audits" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "website_url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "observation_source" TEXT NOT NULL DEFAULT 'manual_observation',
    "observations" JSONB NOT NULL,
    "notes" TEXT,
    "page_count" INTEGER NOT NULL,
    "finding_count" INTEGER NOT NULL,
    "urgent_count" INTEGER NOT NULL DEFAULT 0,
    "warning_count" INTEGER NOT NULL DEFAULT 0,
    "info_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_audits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_audit_findings" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "website_audit_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "recommendation" TEXT NOT NULL,
    "page_url" TEXT,
    "source_type" TEXT NOT NULL,
    "source_record_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "website_audit_findings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "website_content_proposals" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "website_audit_id" TEXT,
    "proposal_type" TEXT NOT NULL,
    "target_page_url" TEXT NOT NULL,
    "headline" TEXT,
    "content_body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ready_for_review',
    "source_snapshot" JSONB NOT NULL,
    "notes" TEXT,
    "decision_notes" TEXT,
    "reviewed_by" TEXT,
    "reviewed_at" TIMESTAMP(3),
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "website_content_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "company_id" TEXT NOT NULL,
    "user_id" TEXT,
    "action_name" TEXT NOT NULL,
    "interpreted_intent" TEXT,
    "input_payload" JSONB,
    "data_before" JSONB,
    "data_after" JSONB,
    "risk_level" INTEGER NOT NULL,
    "confirmation_required" BOOLEAN NOT NULL DEFAULT false,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "result" TEXT NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "connector_sources_company_id_service_type_idx" ON "connector_sources"("company_id", "service_type");

-- CreateIndex
CREATE INDEX "connector_sources_company_id_is_enabled_idx" ON "connector_sources"("company_id", "is_enabled");

-- CreateIndex
CREATE UNIQUE INDEX "connector_sources_company_id_connector_key_display_name_key" ON "connector_sources"("company_id", "connector_key", "display_name");

-- CreateIndex
CREATE INDEX "connector_credentials_company_id_provider_idx" ON "connector_credentials"("company_id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "connector_oauth_states_state_hash_key" ON "connector_oauth_states"("state_hash");

-- CreateIndex
CREATE INDEX "connector_oauth_states_company_id_source_id_expires_at_idx" ON "connector_oauth_states"("company_id", "source_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "clients_company_id_idx" ON "clients"("company_id");

-- CreateIndex
CREATE INDEX "jobs_company_id_idx" ON "jobs"("company_id");

-- CreateIndex
CREATE INDEX "jobs_client_id_idx" ON "jobs"("client_id");

-- CreateIndex
CREATE INDEX "jobs_assigned_user_id_idx" ON "jobs"("assigned_user_id");

-- CreateIndex
CREATE INDEX "jobs_service_catalogue_item_id_idx" ON "jobs"("service_catalogue_item_id");

-- CreateIndex
CREATE INDEX "contacts_company_id_idx" ON "contacts"("company_id");

-- CreateIndex
CREATE INDEX "contacts_company_id_client_id_idx" ON "contacts"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "contacts_company_id_email_idx" ON "contacts"("company_id", "email");

-- CreateIndex
CREATE INDEX "contacts_company_id_phone_idx" ON "contacts"("company_id", "phone");

-- CreateIndex
CREATE INDEX "external_contacts_company_id_is_deleted_idx" ON "external_contacts"("company_id", "is_deleted");

-- CreateIndex
CREATE INDEX "external_contacts_company_id_imported_contact_id_idx" ON "external_contacts"("company_id", "imported_contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_contacts_company_id_connector_source_id_external_r_key" ON "external_contacts"("company_id", "connector_source_id", "external_resource_name");

-- CreateIndex
CREATE INDEX "external_calendars_company_id_is_deleted_idx" ON "external_calendars"("company_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "external_calendars_company_id_connector_source_id_external__key" ON "external_calendars"("company_id", "connector_source_id", "external_calendar_id");

-- CreateIndex
CREATE INDEX "external_calendar_events_company_id_start_at_idx" ON "external_calendar_events"("company_id", "start_at");

-- CreateIndex
CREATE INDEX "external_calendar_events_company_id_is_deleted_idx" ON "external_calendar_events"("company_id", "is_deleted");

-- CreateIndex
CREATE UNIQUE INDEX "external_calendar_events_external_calendar_record_id_extern_key" ON "external_calendar_events"("external_calendar_record_id", "external_event_id");

-- CreateIndex
CREATE INDEX "external_drive_images_company_id_is_removed_idx" ON "external_drive_images"("company_id", "is_removed");

-- CreateIndex
CREATE UNIQUE INDEX "external_drive_images_company_id_connector_source_id_extern_key" ON "external_drive_images"("company_id", "connector_source_id", "external_file_id");

-- CreateIndex
CREATE INDEX "document_records_company_id_idx" ON "document_records"("company_id");

-- CreateIndex
CREATE INDEX "document_records_company_id_client_id_idx" ON "document_records"("company_id", "client_id");

-- CreateIndex
CREATE INDEX "document_records_company_id_job_id_idx" ON "document_records"("company_id", "job_id");

-- CreateIndex
CREATE INDEX "document_records_company_id_document_type_idx" ON "document_records"("company_id", "document_type");

-- CreateIndex
CREATE INDEX "leads_company_id_idx" ON "leads"("company_id");

-- CreateIndex
CREATE INDEX "service_catalogue_items_company_id_idx" ON "service_catalogue_items"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_catalogue_items_company_id_reference_activity_code_key" ON "service_catalogue_items"("company_id", "reference_activity_code");

-- CreateIndex
CREATE INDEX "quotes_company_id_idx" ON "quotes"("company_id");

-- CreateIndex
CREATE INDEX "quotes_client_id_idx" ON "quotes"("client_id");

-- CreateIndex
CREATE INDEX "quotes_job_id_idx" ON "quotes"("job_id");

-- CreateIndex
CREATE INDEX "quote_items_quote_id_idx" ON "quote_items"("quote_id");

-- CreateIndex
CREATE INDEX "quote_items_service_catalogue_item_id_idx" ON "quote_items"("service_catalogue_item_id");

-- CreateIndex
CREATE INDEX "job_openings_company_id_idx" ON "job_openings"("company_id");

-- CreateIndex
CREATE INDEX "candidates_company_id_idx" ON "candidates"("company_id");

-- CreateIndex
CREATE INDEX "candidates_job_opening_id_idx" ON "candidates"("job_opening_id");

-- CreateIndex
CREATE INDEX "playbooks_company_id_idx" ON "playbooks"("company_id");

-- CreateIndex
CREATE INDEX "playbook_runs_company_id_idx" ON "playbook_runs"("company_id");

-- CreateIndex
CREATE INDEX "playbook_runs_playbook_id_idx" ON "playbook_runs"("playbook_id");

-- CreateIndex
CREATE INDEX "learning_rules_company_id_idx" ON "learning_rules"("company_id");

-- CreateIndex
CREATE INDEX "communication_records_company_id_idx" ON "communication_records"("company_id");

-- CreateIndex
CREATE INDEX "communication_records_client_id_idx" ON "communication_records"("client_id");

-- CreateIndex
CREATE INDEX "communication_records_job_id_idx" ON "communication_records"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_intakes_communication_record_id_key" ON "communication_intakes"("communication_record_id");

-- CreateIndex
CREATE INDEX "communication_intakes_company_id_intake_status_idx" ON "communication_intakes"("company_id", "intake_status");

-- CreateIndex
CREATE INDEX "communication_intakes_company_id_resolution_needed_idx" ON "communication_intakes"("company_id", "resolution_needed");

-- CreateIndex
CREATE INDEX "communication_intakes_client_id_idx" ON "communication_intakes"("client_id");

-- CreateIndex
CREATE INDEX "communication_intakes_connector_source_id_idx" ON "communication_intakes"("connector_source_id");

-- CreateIndex
CREATE UNIQUE INDEX "communication_intakes_company_id_connector_source_id_extern_key" ON "communication_intakes"("company_id", "connector_source_id", "external_message_id");

-- CreateIndex
CREATE INDEX "tasks_company_id_task_status_idx" ON "tasks"("company_id", "task_status");

-- CreateIndex
CREATE INDEX "tasks_assigned_user_id_due_at_idx" ON "tasks"("assigned_user_id", "due_at");

-- CreateIndex
CREATE INDEX "tasks_client_id_idx" ON "tasks"("client_id");

-- CreateIndex
CREATE INDEX "tasks_job_id_idx" ON "tasks"("job_id");

-- CreateIndex
CREATE INDEX "tasks_communication_record_id_idx" ON "tasks"("communication_record_id");

-- CreateIndex
CREATE INDEX "notification_acknowledgements_company_id_idx" ON "notification_acknowledgements"("company_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_acknowledgements_company_id_notification_key_key" ON "notification_acknowledgements"("company_id", "notification_key");

-- CreateIndex
CREATE INDEX "portfolio_photos_company_id_idx" ON "portfolio_photos"("company_id");

-- CreateIndex
CREATE INDEX "portfolio_photos_client_id_idx" ON "portfolio_photos"("client_id");

-- CreateIndex
CREATE INDEX "portfolio_photos_job_id_idx" ON "portfolio_photos"("job_id");

-- CreateIndex
CREATE INDEX "photo_service_selections_company_id_idx" ON "photo_service_selections"("company_id");

-- CreateIndex
CREATE INDEX "photo_service_selections_portfolio_photo_id_idx" ON "photo_service_selections"("portfolio_photo_id");

-- CreateIndex
CREATE UNIQUE INDEX "photo_service_selections_service_catalogue_item_id_portfoli_key" ON "photo_service_selections"("service_catalogue_item_id", "portfolio_photo_id");

-- CreateIndex
CREATE INDEX "business_context_items_company_id_idx" ON "business_context_items"("company_id");

-- CreateIndex
CREATE INDEX "business_context_items_company_id_category_idx" ON "business_context_items"("company_id", "category");

-- CreateIndex
CREATE INDEX "industries_company_id_is_active_idx" ON "industries"("company_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "industries_company_id_name_key" ON "industries"("company_id", "name");

-- CreateIndex
CREATE INDEX "industry_service_links_company_id_idx" ON "industry_service_links"("company_id");

-- CreateIndex
CREATE INDEX "industry_service_links_service_catalogue_item_id_idx" ON "industry_service_links"("service_catalogue_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "industry_service_links_industry_id_service_catalogue_item_i_key" ON "industry_service_links"("industry_id", "service_catalogue_item_id");

-- CreateIndex
CREATE INDEX "website_audits_company_id_created_at_idx" ON "website_audits"("company_id", "created_at");

-- CreateIndex
CREATE INDEX "website_audit_findings_company_id_status_idx" ON "website_audit_findings"("company_id", "status");

-- CreateIndex
CREATE INDEX "website_audit_findings_website_audit_id_idx" ON "website_audit_findings"("website_audit_id");

-- CreateIndex
CREATE INDEX "website_content_proposals_company_id_status_idx" ON "website_content_proposals"("company_id", "status");

-- CreateIndex
CREATE INDEX "website_content_proposals_website_audit_id_idx" ON "website_content_proposals"("website_audit_id");

-- CreateIndex
CREATE INDEX "audit_log_company_id_created_at_idx" ON "audit_log"("company_id", "created_at");

-- AddForeignKey
ALTER TABLE "connector_sources" ADD CONSTRAINT "connector_sources_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_credentials" ADD CONSTRAINT "connector_credentials_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connector_oauth_states" ADD CONSTRAINT "connector_oauth_states_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clients" ADD CONSTRAINT "clients_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_service_catalogue_item_id_fkey" FOREIGN KEY ("service_catalogue_item_id") REFERENCES "service_catalogue_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_contacts" ADD CONSTRAINT "external_contacts_imported_contact_id_fkey" FOREIGN KEY ("imported_contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_calendars" ADD CONSTRAINT "external_calendars_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_calendar_events" ADD CONSTRAINT "external_calendar_events_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_calendar_events" ADD CONSTRAINT "external_calendar_events_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_calendar_events" ADD CONSTRAINT "external_calendar_events_external_calendar_record_id_fkey" FOREIGN KEY ("external_calendar_record_id") REFERENCES "external_calendars"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_drive_images" ADD CONSTRAINT "external_drive_images_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_drive_images" ADD CONSTRAINT "external_drive_images_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_drive_images" ADD CONSTRAINT "external_drive_images_portfolio_photo_id_fkey" FOREIGN KEY ("portfolio_photo_id") REFERENCES "portfolio_photos"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_records" ADD CONSTRAINT "document_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_records" ADD CONSTRAINT "document_records_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_records" ADD CONSTRAINT "document_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_catalogue_items" ADD CONSTRAINT "service_catalogue_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_service_catalogue_item_id_fkey" FOREIGN KEY ("service_catalogue_item_id") REFERENCES "service_catalogue_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_openings" ADD CONSTRAINT "job_openings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_job_opening_id_fkey" FOREIGN KEY ("job_opening_id") REFERENCES "job_openings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbooks" ADD CONSTRAINT "playbooks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "playbook_runs" ADD CONSTRAINT "playbook_runs_playbook_id_fkey" FOREIGN KEY ("playbook_id") REFERENCES "playbooks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "learning_rules" ADD CONSTRAINT "learning_rules_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_records" ADD CONSTRAINT "communication_records_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_records" ADD CONSTRAINT "communication_records_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_records" ADD CONSTRAINT "communication_records_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_intakes" ADD CONSTRAINT "communication_intakes_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_intakes" ADD CONSTRAINT "communication_intakes_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_intakes" ADD CONSTRAINT "communication_intakes_communication_record_id_fkey" FOREIGN KEY ("communication_record_id") REFERENCES "communication_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_intakes" ADD CONSTRAINT "communication_intakes_connector_source_id_fkey" FOREIGN KEY ("connector_source_id") REFERENCES "connector_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_communication_record_id_fkey" FOREIGN KEY ("communication_record_id") REFERENCES "communication_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_user_id_fkey" FOREIGN KEY ("assigned_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_acknowledgements" ADD CONSTRAINT "notification_acknowledgements_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_photos" ADD CONSTRAINT "portfolio_photos_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_photos" ADD CONSTRAINT "portfolio_photos_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_photos" ADD CONSTRAINT "portfolio_photos_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_service_selections" ADD CONSTRAINT "photo_service_selections_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_service_selections" ADD CONSTRAINT "photo_service_selections_service_catalogue_item_id_fkey" FOREIGN KEY ("service_catalogue_item_id") REFERENCES "service_catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_service_selections" ADD CONSTRAINT "photo_service_selections_portfolio_photo_id_fkey" FOREIGN KEY ("portfolio_photo_id") REFERENCES "portfolio_photos"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "business_context_items" ADD CONSTRAINT "business_context_items_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "industries" ADD CONSTRAINT "industries_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "industry_service_links" ADD CONSTRAINT "industry_service_links_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "industry_service_links" ADD CONSTRAINT "industry_service_links_industry_id_fkey" FOREIGN KEY ("industry_id") REFERENCES "industries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "industry_service_links" ADD CONSTRAINT "industry_service_links_service_catalogue_item_id_fkey" FOREIGN KEY ("service_catalogue_item_id") REFERENCES "service_catalogue_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_audits" ADD CONSTRAINT "website_audits_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_audit_findings" ADD CONSTRAINT "website_audit_findings_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_audit_findings" ADD CONSTRAINT "website_audit_findings_website_audit_id_fkey" FOREIGN KEY ("website_audit_id") REFERENCES "website_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_content_proposals" ADD CONSTRAINT "website_content_proposals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_content_proposals" ADD CONSTRAINT "website_content_proposals_website_audit_id_fkey" FOREIGN KEY ("website_audit_id") REFERENCES "website_audits"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
