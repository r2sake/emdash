#!/bin/bash
COMMIT_ID="1d7cffc5fe7b1ea658e73a4496a7bbaa4cf7c1ea"

gh api repos/emdash-cms/emdash/pulls/719/reviews \
  -X POST \
  -f event=REQUEST_CHANGES \
  -f body="" \
  -f "comments[][path]=packages/admin/src/components/ContentEditor.tsx" \
  -f "comments[][line]=1287" \
  -f "comments[][side]=RIGHT" \
  -f "comments[][body]=**Needs fixing:** The comment says value may be \"a legacy string URL\", but the very next line casts any string to \`undefined\` before passing it to \`FileFieldRenderer\`. This makes existing string data invisible in the UI — a regression from the previous behavior where it at least rendered in a text input. For parity with \`ImageFieldRenderer\` (which accepts \`string | undefined\` and renders legacy URLs), consider passing raw \`value\` to \`FileFieldRenderer\` and handling strings there (e.g., showing them as a plain link with a clear button), or update the comment to remove the legacy-string claim if dropping support is intentional." \
  -f "comments[][path]=packages/admin/src/components/ContentEditor.tsx" \
  -f "comments[][line]=1627" \
  -f "comments[][side]=RIGHT" \
  -f "comments[][body]=**Needs fixing:** JSDoc drift — the comment lists \`{ id, src?, filename?, mimeType?, size? }\` but \`FileFieldValue\` also includes \`provider?\` and \`meta?\`. The PR description explicitly calls out schema drift as harmful; the same applies to inline docs.\n\nSuggested fix:\n\`\`\`\n/** File field value — matches the \"file\" shape validated by the Zod generator: { id, provider?, src?, filename?, mimeType?, size?, meta? } */\n\`\`\`" \
  -f "comments[][path]=packages/admin/src/components/ContentEditor.tsx" \
  -f "comments[][line]=1666" \
  -f "comments[][side]=RIGHT" \
  -f "comments[][body]=**Suggestion:** \`typeof value === \"string\"\` is unreachable here because \`value\` is typed \`FileFieldValue | undefined\`. The \`case \"file\"\` branch already filters out strings before passing the value in. Removing this dead code keeps the normalization logic aligned with the type system." \
  -f "comments[][path]=packages/admin/src/components/ContentEditor.tsx" \
  -f "comments[][line]=1698" \
  -f "comments[][side]=RIGHT" \
  -f "comments[][body]=**Needs fixing:** \`const hasSize = normalized?.size;\` uses truthiness, so a valid size of \`0\` bytes evaluates to \`false\` and the size label won't render (even though \`formatFileSize(0)\` correctly returns \"0 B\"). Use an explicit numeric check instead:\n\n\`\`\`ts\nconst hasSize = typeof normalized?.size === \"number\";\n\`\`\`\n\nWith this change you can also drop the \`as number\` cast on line 1725." \
  -f "comments[][path]=packages/admin/src/components/MediaPickerModal.tsx" \
  -f "comments[][line]=78" \
  -f "comments[][side]=RIGHT" \
  -f "comments[][body]=**Suggestion:** When \`hideUrlInput\` is used for non-image pickers, several image-centric strings remain that make the UX confusing for file attachments: the default title is \"Select Image\" (line 78), the empty state says \"Upload an image to get started\" (line 507), the fallback CTA button says \"Upload Image\" (line 516), and the empty-state icon is \`<Image />\` (line 501). Consider adding a \`mediaTypeLabel\` prop (defaulting to \`Image\`) so these can be parameterized for generic file pickers."
