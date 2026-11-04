-- A human can put a dunning case on hold until a date (for example after a dispute or an extension
-- request). While hold_until is in the future the planner proposes nothing and a step refuses to send.
alter table public.dunning_cases add column if not exists hold_until date;
