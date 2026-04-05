import { BorrowerEnvironment, BorrowerEndpoint } from './types.js'

export const BASE_URLS: Record<BorrowerEnvironment, string> = {
  [BorrowerEnvironment.STAGING]: 'https://api.finhero.asia/stage/buyerfuel/v1',
  [BorrowerEnvironment.PRODUCTION]: 'https://api.finhero.asia/buyerfuel/v1',
}

export const ENDPOINT_PATHS: Record<BorrowerEndpoint, string> = {
  [BorrowerEndpoint.LOGIN]: '/login',
  [BorrowerEndpoint.SUBMISSION]: '/ihs/submission',
  [BorrowerEndpoint.UPDATE]: '/update',
  [BorrowerEndpoint.UPLOAD_FILE]: '/uploadFile',
  [BorrowerEndpoint.STATUS]: '/ihs/status',
  [BorrowerEndpoint.CREATE_CONSENT]: '/ihs/createConsentEvent',
}
