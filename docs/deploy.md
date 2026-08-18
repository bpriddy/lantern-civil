# Deploying Civil

Infrastructure is Terraform; the deploy itself is one script. PRD §2 asks for exactly
one of each.

## One-time setup

Already done for `lantern-civil`, recorded here so a clean checkout can repeat it.

```bash
gcloud projects create lantern-civil --name="Civil"
gcloud billing projects link lantern-civil --billing-account=<ACCOUNT_ID>
gcloud services enable run sqladmin secretmanager iap cloudbuild \
  artifactregistry compute iamcredentials storage --project=lantern-civil
gcloud beta services identity create --service=iap.googleapis.com --project=lantern-civil
gcloud storage buckets create gs://lantern-civil-tfstate \
  --project=lantern-civil --location=us-central1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://lantern-civil-tfstate --versioning
```

Then:

```bash
cp infra/terraform/example.tfvars infra/terraform/terraform.tfvars   # edit it
terraform -chdir=infra/terraform init
terraform -chdir=infra/terraform apply
```

## The one manual step: IAP's OAuth consent screen

**This cannot be scripted at all,** and it is the only part of the deploy that is
not in Terraform.

The IAP OAuth Admin APIs — `gcloud iap oauth-brands`, and the Terraform resources
built on them — were permanently shut down on 19 March 2026. On a project with no
organization they now fail outright:

```
ERROR: (gcloud.iap.oauth-brands.list) INVALID_ARGUMENT: Project must belong to an organization.
```

So this is not "inconvenient to automate". There is no API left to automate against.

IAP defaults to a Google-managed OAuth client that admits "only users within the
organization." A personal Google account has no organization, so that set is empty
and every login is refused — a failure that looks like a bug rather than a
configuration gap.

The fix is to configure the consent screen once, in the console:

1. Open **APIs & Services → OAuth consent screen** in the `lantern-civil` project.
2. Choose **External** as the user type. (There is no Internal option without an
   organization.)
3. Fill in an app name and your email for both the support and developer contact
   fields. Nothing else is required — no scopes, no domains.
4. Save. Leave the app in **Testing**; add your own address under **Test users**.
   Publishing invites a verification review this does not need.

Test-mode OAuth clients issue refresh tokens that expire after seven days. That
affects long-lived offline access, not IAP session logins, so it does not matter
here.

### Symptom if you skip it

The service returns **502** with `x-goog-iap-generated-response: true`. That header
means IAP is in the path and working; the 502 is IAP failing to *start* a login flow
because no OAuth client exists. It is not a Cloud Run error and no amount of looking
at the container will explain it.

Then confirm IAP sees the service:

```bash
gcloud iap settings get --resource-type=cloud-run \
  --service=civil --region=us-central1 --project=lantern-civil
```

## Every deploy after that

```bash
./scripts/deploy.sh
```

It builds the image with Cloud Build, tags it with the current git sha (suffixed
`-dirty` if the tree is not clean), runs migrations as a Cloud Run job from that
same image, and only then updates the service. Migrations before deploy is the safe
ordering for additive migrations — and additive is a discipline, not something
Terraform enforces.

## Cost

At the tier provisioned here, roughly $20–25/month: Cloud SQL `db-f1-micro` on the
ENTERPRISE edition, plus one always-warm Cloud Run instance.

One thing to know before M4: the warm instance has `cpu_idle = true`, so its CPU is
throttled between requests. That is fine for serving, but §12's long-running,
request-independent job ownership needs `cpu_idle = false`, and always-allocated vCPU
is billed at roughly ten times the idle rate. Budget for that when M4 lands rather
than being surprised by it.

## Tearing down

```bash
terraform -chdir=infra/terraform apply -var db_deletion_protection=false
terraform -chdir=infra/terraform destroy
```

The state bucket and the project itself are outside Terraform and must go by hand.
