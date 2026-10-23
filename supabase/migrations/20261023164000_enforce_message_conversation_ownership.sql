-- Ensure a message can only reference a conversation owned by the same authenticated user.
-- This closes a cross-owner foreign-key path while preserving the current application data model.

DROP POLICY IF EXISTS "Users can create their own messages" ON public.chat_messages;

CREATE POLICY "Users can create their own messages"
ON public.chat_messages
FOR INSERT
TO authenticated
WITH CHECK (
  owner_id = (SELECT auth.uid())
  AND EXISTS (
    SELECT 1
    FROM public.chat_conversations AS c
    WHERE c.id = chat_messages.conversation_id
      AND c.owner_id = (SELECT auth.uid())
  )
);
