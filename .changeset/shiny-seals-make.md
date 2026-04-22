---
"@emdash-cms/admin": patch
---

Fixes the `file` field type rendering as a plain text input in the content editor. Adds a `FileFieldRenderer` that opens the media picker (with mime filter disabled) so any file type can be attached. Also adds a `hideUrlInput` prop to `MediaPickerModal` so non-image pickers can hide the image-specific "Insert from URL" input.
