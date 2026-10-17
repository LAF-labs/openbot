/**
 * The largest team file a person sends from the 회사 screen, and the body around it.
 *
 * The hub's own limit is a gigabyte a file (the same a Bot's download may be). The screen checks it
 * before sending and the server's door (`server/src/hub/routes-ui.ts`, and the table of bodies
 * allowed past a megabyte in `server/src/middleware/security.ts`) holds the body to it, so a file
 * the hub would refuse is refused before it is sent rather than after a gigabyte has crossed.
 */
export const HUB_UPLOAD_FILE_MAX_BYTES = 1024 * 1024 * 1024;

/** The file and the multipart envelope around it (`meta`, the part headers, the boundaries). */
export const HUB_UPLOAD_MAX_BYTES = HUB_UPLOAD_FILE_MAX_BYTES + 256 * 1024;
