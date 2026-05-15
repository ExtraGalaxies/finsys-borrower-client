export { BorrowerApiClient } from './client.js'
export { BASE_URLS, ENDPOINT_PATHS } from './environments.js'
export {
  BorrowerEnvironment,
  BorrowerEndpoint,
  buildSubmissionPayloads,
  type BorrowerClientConfig,
  type UploadResult,
  type UploadedFileRef,
  type UpstreamErrorDetail,
  type SubmissionResult,
  type UpdateResult,
  type StatusResult,
  type ConnectionTestResult,
  type ConsentEventResult,
  type SubmissionPayloads,
} from './types.js'
export {
  resolvePayloadTransfer,
  listDocumentPatterns,
  type FileFieldFormat,
  type PayloadTransferKind,
  type PayloadTransferRule,
} from './payload-transfer.js'
