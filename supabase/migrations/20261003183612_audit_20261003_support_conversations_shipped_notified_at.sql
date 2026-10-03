-- audit_20261003_support_conversations_shipped_notified_at
--
-- When the team moves a logged bug / feature request to `shipped` in
-- /admin/feedback, the reader who asked for it is emailed once (lib/emails/
-- feedback-shipped-email.ts, sent from app/api/admin/feedback/[id]/route.ts).
-- This column is the send receipt: NULL = never sent, a timestamp = sent at.
-- It is what makes the send idempotent across a re-save or a status bounce
-- (shipped → in_progress → shipped) and what a later audit reads.
--
-- Revert: ALTER TABLE public.support_conversations DROP COLUMN shipped_notified_at;

ALTER TABLE public.support_conversations
  ADD COLUMN IF NOT EXISTS shipped_notified_at timestamptz NULL;

COMMENT ON COLUMN public.support_conversations.shipped_notified_at IS
  'When the "your request shipped" email was sent to user_email (NULL = never). Written by /api/admin/feedback/[id] on the first transition to shipped; idempotency key for that send.';
