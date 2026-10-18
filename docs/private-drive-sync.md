# Legacy Drive sync

The Drive destination has been replaced by the [private Notion progress summary](private-notion-sync.md). Drive permissions are no longer requested and no Google access/refresh tokens are persisted by the new identity-only sign-in. Existing Drive files and old encrypted records are not deleted or migrated automatically. Old pending browser queues require explicit recovery review and are never silently sent to Notion.
