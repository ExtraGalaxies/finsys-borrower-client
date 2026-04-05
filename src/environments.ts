import { BorrowerEnvironment, BorrowerEndpoint } from './types.js'

export const BASE_URLS: Record<BorrowerEnvironment, string> = {
  [BorrowerEnvironment.STAGING]: 'https://finsys-api-stage.finhero.asia',
  [BorrowerEnvironment.PRODUCTION]: 'https://finsys-api.finhero.asia',
}

export const ENDPOINT_PATHS: Record<BorrowerEndpoint, string> = {
  [BorrowerEndpoint.LOGIN]: '/auth/client/login',
  [BorrowerEndpoint.SUBMISSION]: '/client/ihs/client/submission',
  [BorrowerEndpoint.UPDATE]: '/client/ihs/update',
  [BorrowerEndpoint.UPLOAD_FILE]: '/file/upload/file/temp',
  [BorrowerEndpoint.STATUS]: '/client/ihs/check/status',
  [BorrowerEndpoint.CREATE_CONSENT]: '/client/ihs/createConsentEvent',
}
