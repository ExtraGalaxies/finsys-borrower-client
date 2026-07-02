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
| `staging` | `https://finsys-api-stage.finhero.asia` |
| `production` | `https://finsys-api.finhero.asia` |

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

/**
 * Typed upstream error detail surfaced on failed result objects (3.5.0+).
 * Populated when the underlying axios call receives a response from finsys-api.
 * All fields optional: WAF blocks at App Gateway arrive with no body, so only
 * `status` is set. Some legacy paths return only a `message` string, so
 * `code`/`desc` may be undefined.
 */
interface UpstreamErrorDetail {
  code?: string    // e.g. "APPLICATION_IS_FINALIZED"
  desc?: string    // human-readable description from finsys-api err.desc
  status?: number  // HTTP status from the upstream response
}

interface UploadResult {
  success: boolean
  url?: string
  data?: unknown
  message?: string
  upstream?: UpstreamErrorDetail  // 3.5.0+, on failure only
}

interface SubmissionResult {
  success: boolean
  applicationId?: string
  ihsId?: string
  message?: string
  errors?: Record<string, string[]>
  data?: unknown
  upstream?: UpstreamErrorDetail  // 3.5.0+, on failure only
}

interface UpdateResult {
  success: boolean
  message?: string
  data?: unknown
  upstream?: UpstreamErrorDetail  // 3.5.0+, on failure only
}

interface StatusResult {
  success: boolean
  ihsId?: string
  status?: string
  message?: string
  data?: unknown
  upstream?: UpstreamErrorDetail  // 3.5.0+, on failure only
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

## Reading upstream errors (3.5.0+)

When a request fails, the result includes a typed `upstream` field with the
upstream HTTP status and (when available) the finsys-api error code and
description:

```typescript
const result = await client.updateApplication(ihsId, payload)

if (!result.success) {
  console.error('Update failed:', {
    status: result.upstream?.status,
    code: result.upstream?.code,
    desc: result.upstream?.desc,
  })
}
```

`code` and `desc` are populated when the upstream returns the
`{ err: { code, desc } }` shape (the common case from `finsys-api`).
For WAF blocks at the App Gateway, the response body is empty and only
`status` is set.

## License

Apache-2.0
