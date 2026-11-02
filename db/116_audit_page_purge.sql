-- Retention purge deletes the page row. Follow and other audits keep their trail and only drop the page reference.
ALTER TABLE hs_audit DROP CONSTRAINT IF EXISTS hs_audit_page_id_fkey;
ALTER TABLE hs_audit
  ADD CONSTRAINT hs_audit_page_id_fkey
  FOREIGN KEY (page_id) REFERENCES hs_pages(id) ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION hs_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.page_id IS NOT NULL
     AND NEW.page_id IS NULL
     AND ROW(NEW.id, NEW.actor_id, NEW.action, NEW.subject_id, NEW.before_value, NEW.after_value, NEW.correlation_id, NEW.created_at)
         IS NOT DISTINCT FROM
         ROW(OLD.id, OLD.actor_id, OLD.action, OLD.subject_id, OLD.before_value, OLD.after_value, OLD.correlation_id, OLD.created_at)
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Audit events are append-only';
END;
$$;
