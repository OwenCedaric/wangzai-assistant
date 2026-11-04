ALTER TABLE model_api_accounts ADD COLUMN available_models_json TEXT;
ALTER TABLE model_api_accounts ADD COLUMN capabilities_json TEXT;
ALTER TABLE model_api_accounts ADD COLUMN discovery_verified INTEGER NOT NULL DEFAULT 0 CHECK (discovery_verified IN (0, 1));
