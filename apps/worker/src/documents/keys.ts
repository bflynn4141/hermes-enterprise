// Where a rendered document lives.
//
// The third shape `src/storage/keys.ts` names in its header, filled in here so
// that the render pipeline owns its own key rather than reaching across into
// the uploads module:
//
//     w/{workspace}/documents/{document}/v{version}.html
//     w/{workspace}/documents/{document}/v{version}.pdf
//
// Version is in the key, not only in the row, for the reason a version exists
// at all: a re-version after a decision must not overwrite the bytes the
// approver read. The old object stays reachable, so "what did I approve?" has
// an answer that is not "whatever the latest render says".

export const documentPrefix = (workspaceId: string, documentId: string): string =>
  `w/${workspaceId}/documents/${documentId}/`;

export const documentHtmlKey = (workspaceId: string, documentId: string, version: number): string =>
  `${documentPrefix(workspaceId, documentId)}v${version}.html`;

export const documentPdfKey = (workspaceId: string, documentId: string, version: number): string =>
  `${documentPrefix(workspaceId, documentId)}v${version}.pdf`;
