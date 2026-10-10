# NoDo production deployment boundary

This document prepares only the NoDo deployment in GCP project
`example-gcp-project`.  It does not authorize creation, IAM changes, or a deploy.

## Fixed production boundary

| Resource | Fixed value |
| --- | --- |
| Cloud Run region and service | `asia-northeast3` / `nodo-api` |
| Runtime service account | `nodo-runtime@example-gcp-project.iam.gserviceaccount.com` |
| Artifact Registry repository | `nodo` in `asia-northeast3` |
| Firebase Hosting site | `example-gcp-project-nodo` |
| Frontend origins | `https://example-gcp-project-nodo.web.app` and `https://example-gcp-project-nodo.firebaseapp.com` |
| Firestore | `(default)` only |
| Private material bucket | `example-gcp-project-nodo-materials` only |

`firebase.nodo.hosting.json` is a Hosting-only configuration.  It does not
deploy the default Hosting site, Firestore Rules, or Indexes.  It serves the
SPA from `web/dist` and rewrites application routes to `index.html`.

Build the frontend only after setting local, non-committed production values:

```powershell
npm --prefix web run build:hosting
firebase deploy --config firebase.nodo.hosting.json --project example-gcp-project --only hosting
```

The `VITE_API_BASE_URL` value must be the generated HTTPS URL for
`nodo-api`; blank production configuration fails closed.  The FastAPI
container uses `backend/.env.cloud-run.example` as a variable-name contract.
Cloud Auth production also fails closed when its Firebase project, Firestore
database, Storage bucket, or fixed CORS origins do not match this boundary.

## Runtime identity and minimum permissions

The Cloud Run service must use `nodo-runtime`, never the default Compute
Engine service account and never a service-account JSON.  Firebase Admin and
Google SDKs use Cloud Run Application Default Credentials from that runtime
identity.

- Grant Firestore access only for NoDo server operations against `(default)`;
  `roles/datastore.user` is the baseline role, scoped as narrowly as the
  organization policy allows.
- Grant `roles/storage.objectUser` only on
  `gs://example-gcp-project-nodo-materials`, not at project scope and not on the
  friend-service bucket.
- Grant `roles/aiplatform.user` only if Vertex AI drafts are enabled in the
  production environment; keep it separate from the baseline runtime role.
- Do not grant project-wide Editor.  Deployment principals, not the runtime
  service account, need the separately reviewed Cloud Run, Artifact Registry,
  and Firebase Hosting deployment roles.
- Cloud Run may allow unauthenticated invocation (`allUsers` as invoker) so
  the browser can reach the API.  FastAPI still verifies each Firebase ID
  Token and organization/room permission; CORS accepts only the fixed NoDo
  Hosting origins and the existing `localhost:5175` development origin.

Before the first Hosting deploy, confirm both NoDo Hosting domains are approved
domains for the NoDo web app. Do not change providers or approved domains
without a separate approval.

## Approved-next-step checklist

Only after explicit approval: enable missing Cloud Run, Cloud Build, and
Artifact Registry APIs; create or reuse the fixed resources; grant the scoped
roles above; deploy the backend and Hosting site; and run a real HTTPS smoke
test.  Do not touch the default Hosting site, any friend-service database or
bucket, Firestore Rules/Indexes, Authentication providers, billing, or Google
Slides settings.
