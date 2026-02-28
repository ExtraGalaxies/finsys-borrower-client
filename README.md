# @finsys/borrower-client

Client library for the FinSys Borrower API — handles authentication, file uploads, and two-step loan application submission.

## Install

```bash
npm install @finsys/borrower-client @finsys/core
```

`@finsys/core` is a peer dependency that provides shared form configuration types.

## Quick Start

```typescript
import {
  BorrowerApiClient,
  BorrowerEnvironment,
  buildSubmissionPayloads,
} from '@finsys/borrower-client'

// 1. Create a client
const client = new BorrowerApiClient({
  environment: BorrowerEnvironment.STAGING,
  credentials: {
    clientId: 'your-client-id',
    clientSecret: 'your-client-secret',
    gatewayKey: 'optional-gateway-key', // Azure APIM subscription key
  },
})

// 2. Test the connection
const { success, message } = await client.testConnection()

// 3. Upload a file
const result = await client.uploadFile(fileBuffer, 'document.pdf')
console.log(result.url) // blob storage URL

// 4. Build submission payloads from form data
const formData = {
  totalFinancing: 329000,
  fullName: 'John Doe',
  email: 'john@example.com',
  bank_statement_t1: [{ url: result.url, name: 'document.pdf' }],
}

const { createPayload, finalizePayload } = buildSubmissionPayloads(
  formData,
  formConfig.fields // Record<string, FieldData> from @finsys/core
)

// 5. Two-step submission
const created = await client.submitApplication({
  ...createPayload,
  status: 'CREATING_APPLICATION',
})

await client.updateApplication(created.ihsId, {
  ...finalizePayload,
  status: 'APPLICATION_FINALIZED',
})
```

## API

### `BorrowerApiClient`

#### `constructor(config: BorrowerClientConfig)`

Creates a client instance. Environment determines the base URL:

| Environment | Base URL |
|-------------|----------|
| `staging` | `https://api.finhero.asia/stage/buyerfuel/v1` |
| `production` | `https://api.finhero.asia/buyerfuel/v1` |

Use `endpointOverrides` to override individual endpoint URLs when needed.

#### `login(): Promise<string>`

Authenticates and returns a bearer token. Tokens are cached and auto-refreshed.

#### `uploadFile(fileBuffer: Buffer, fileName: string): Promise<UploadResult>`

Uploads a file and returns the blob storage URL.

#### `submitApplication(payload): Promise<SubmissionResult>`

Creates a new loan application (POST). Returns `ihsId` on success.

#### `updateApplication(ihsId: string, payload): Promise<UpdateResult>`

Updates an existing application (PATCH). Used to finalize with document URLs.

#### `testConnection(): Promise<ConnectionTestResult>`

Tests connectivity by attempting to authenticate.

#### `invalidateToken(): void`

Clears the cached auth token, forcing re-authentication on the next call.

### `buildSubmissionPayloads(formData, fields, now?)`

Transforms form data into the two payloads needed for the two-step submission flow.

**Parameters:**
- `formData` — Form values (`Record<string, unknown>`). File fields should contain `UploadedFileRef[]` or plain URL strings.
- `fields` — Form config fields (`Record<string, FieldData>` from `@finsys/core`). File fields are identified by `type: 'file'`.
- `now` — Optional `Date` for bank statement year computation (defaults to current date).

**Returns:** `{ createPayload, finalizePayload }`

- `createPayload` — Metadata only (no file references). Used for the initial POST.
- `finalizePayload` — Updatable metadata + transformed document references. Used for the PATCH.

**Field name conventions:**

File fields are mapped to the API format based on their names:

| Field pattern | API field | Format |
|---------------|-----------|--------|
| `bank_statement_tN` | `bankStatements` | `[{ path, month: N, year }]` |
| `financials*` | `financialStatements` | `[{ path, year: ordinal }]` |
| `ssm` | `form9` | `"url"` |

Contact/consent fields (`email`, `fullName`, `mobilePhoneNo`, `formOfDisclosure`) are automatically excluded from the finalize payload, as the API rejects these on update.

## Types

```typescript
interface UploadedFileRef {
  url: string
  name: string
}

interface UploadResult {
  success: boolean
  url?: string
  data?: unknown
  message?: string
}

interface SubmissionResult {
  success: boolean
  applicationId?: string
  ihsId?: string
  message?: string
  errors?: Record<string, string[]>
  data?: unknown
}

interface UpdateResult {
  success: boolean
  message?: string
  data?: unknown
}

interface ConnectionTestResult {
  success: boolean
  message: string
}

interface SubmissionPayloads {
  createPayload: Record<string, unknown>
  finalizePayload: Record<string, unknown>
}
```

## License

Apache-2.0
