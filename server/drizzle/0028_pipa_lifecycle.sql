-- The two maintenance seams a lifecycle needs, cut through a trail that refuses to be edited.
--
-- NUMBERED 0028 ON PURPOSE, WITH 0027 LEFT EMPTY. A concurrent surface wave is taking 0027 and had
-- not landed when this was written; the journal therefore jumps 26 → 28. Nothing here depends on
-- 0027, so the gap costs an entry in the journal and nothing else.
--
-- THE PROBLEM. `audit_events` is append-only, enforced by `audit_events_append_only` (0000_schema),
-- a BEFORE UPDATE OR DELETE trigger that raises unconditionally. That is the property the trail is
-- worth anything for, and it is also flatly incompatible with the two things a data lifecycle has
-- to do: replace a departed person's actor id with a pseudonym, and drop rows that have aged past
-- the retention period. One of those two rules has to give.
--
-- WHAT WAS CHOSEN, AND WHY. The trigger keeps refusing every ordinary UPDATE and DELETE — from the
-- application, from psql, from anything that has not said what it is doing — and gains exactly two
-- named exits, each a function that says out loud which maintenance it is performing. Both set a
-- transaction-local flag the trigger looks for and clear it again on the way out, so the exit is
-- open for the width of one statement inside one function and nowhere else.
--
-- The alternative considered and rejected was "export the rows and delete them through the same
-- function": it turns a person leaving into a hole in the middle of the trail, and the trail's
-- whole job is to answer what happened. A row whose actor became `deleted-<hash>` still says a
-- withdrawal was approved at 3pm; a row that is gone says nothing and cannot be told from a row
-- that was never written.
--
-- THE UPDATE EXIT IS NARROWER THAN THE FUNCTION THAT USES IT. Even with the flag set, the trigger
-- compares every other column and refuses if any of them moved. So the widest thing this migration
-- can be used for — by anybody, including a future caller with different intentions — is replacing
-- `actor_user_id`. The payload, the event type, the target and the timestamp are as unwritable as
-- they were before.
--
-- SECURITY DEFINER IS NOT THE BOUNDARY HERE, AND SAYING SO MATTERS. This deployment's application
-- connects as the database owner (docs/laf/deployment-model.md: one VM, one process, one role), so
-- the definer's rights are the caller's rights and nothing is gained against a determined caller
-- who can already `DROP TRIGGER`. What is gained is against the ordinary mistake: a migration, a
-- script or a route that means to tidy the trail cannot, because tidying is not what either of
-- these functions does. The declaration is kept because it costs nothing and because a deployment
-- that later runs the application under a narrower role gets the property for free.

CREATE OR REPLACE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Set only inside the two functions below, and cleared before either returns.
  IF current_setting('laf.audit_maintenance', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Maintenance may replace who did it. It may not revise what was done.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.target_type IS DISTINCT FROM OLD.target_type
     OR NEW.target_id IS DISTINCT FROM OLD.target_id
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Audit events are append-only';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

-- Replace one person's actor id everywhere it appears, and say how many rows moved.
--
-- The replacement is computed by the caller (`server/src/account/pseudonym.ts`) rather than here,
-- so the same string can be written into the rows that have no trigger on them and the trail agrees
-- with the rest of the database about who this used to be.
CREATE OR REPLACE FUNCTION audit_pseudonymise_actor(
  p_actor_user_id text,
  p_replacement text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  moved bigint;
BEGIN
  IF p_actor_user_id IS NULL OR p_replacement IS NULL THEN
    RAISE EXCEPTION 'audit_pseudonymise_actor needs both an actor and a replacement';
  END IF;

  PERFORM set_config('laf.audit_maintenance', 'on', true);
  UPDATE audit_events
     SET actor_user_id = p_replacement
   WHERE actor_user_id = p_actor_user_id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  PERFORM set_config('laf.audit_maintenance', 'off', true);

  RETURN moved;
END;
$$;--> statement-breakpoint

-- Drop trail rows older than a cutoff, and say how many went.
--
-- A cutoff rather than a number of days, so the policy lives in one place in the application and
-- this function has no opinion about how long a year is.
CREATE OR REPLACE FUNCTION audit_purge_before(p_cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  removed bigint;
BEGIN
  IF p_cutoff IS NULL THEN
    RAISE EXCEPTION 'audit_purge_before needs a cutoff';
  END IF;

  PERFORM set_config('laf.audit_maintenance', 'on', true);
  DELETE FROM audit_events WHERE created_at < p_cutoff;
  GET DIAGNOSTICS removed = ROW_COUNT;
  PERFORM set_config('laf.audit_maintenance', 'off', true);

  RETURN removed;
END;
$$;
