# FoodiGuard GCP Architecture

This document describes the deployed GCP architecture used for the FoodiGuard demo.

> Note: This repository contains the deployed FoodiGuard frontend/backend source. The cloud architecture uses containerized workloads on GKE, Cloud SQL PostgreSQL, Artifact Registry, Jenkins, and Vertex AI.

## 1. Overall Structure

```text
FoodiGuard GCP Architecture

GitHub Repository
 ├─ Frontend source code
 ├─ Backend source code
 ├─ Docker build settings
 ├─ Jenkins pipeline
 └─ Kubernetes deployment settings
        │
        ▼
Jenkins VM (Compute Engine)
 ├─ Pulls GitHub source from a manual or SCM polling build
 ├─ Pulls latest source code
 ├─ Builds frontend Docker image
 ├─ Builds backend Docker image
 ├─ Pushes images to Artifact Registry
 ├─ Runs the database migration Job
 └─ Updates GKE deployments after migration succeeds
        │
        ▼
Artifact Registry
 ├─ foodiguard-web image
 └─ foodiguard-api image
        │
        ▼
GKE Cluster
 ├─ foodiguard-web Service (LoadBalancer)
 │   └─ Public external IP
 │
 ├─ foodiguard-web Pod
 │   └─ React + Nginx frontend container
 │
 ├─ foodiguard-api Service (ClusterIP)
 │   └─ Internal API endpoint
 │
 ├─ foodiguard-db-migrate Job
 │   ├─ Database migration container
 │   └─ Cloud SQL Proxy native sidecar
 │
 └─ foodiguard-api Pod
     ├─ Express backend container
     │   ├─ Product search API
     │   ├─ Cart nutrition analysis API
     │   ├─ Recommendation scoring engine
     │   ├─ Alternative product recommendation
     │   └─ Vertex AI request handler
     │
     └─ Cloud SQL Proxy container
         └─ Secure connection to Cloud SQL PostgreSQL
                │
                ▼
Cloud SQL PostgreSQL
 ├─ Product data
 ├─ Nutrition data
 ├─ Ingredient data
 └─ User/profile related data

Vertex AI
 └─ Gemini 3.5 Flash
     ├─ Recommendation reason explanation
     ├─ Nutrition score interpretation
     └─ User-friendly explanation generation
```

## 2. Request Flow

```text
User browser
 └─ GCP Load Balancer
     └─ foodiguard-web Service (LoadBalancer)
         └─ foodiguard-web Pod
             └─ React + Nginx frontend container
                 └─ /api requests
                     └─ foodiguard-api Service (ClusterIP)
                         └─ foodiguard-api Pod
                             ├─ Express backend container
                             └─ Cloud SQL Proxy container
                                 └─ Cloud SQL PostgreSQL
```

## 3. Deployment Flow

```text
Developer push to GitHub
 └─ Manual build or SCM polling
     └─ Jenkins VM (IAP-only administration)
         ├─ Build frontend Docker image
         ├─ Build backend Docker image
         ├─ Push images to Artifact Registry
         ├─ Run foodiguard-db-migrate Job
         │   └─ Stop deployment if migration fails
         └─ Apply Kubernetes manifests after success
             ├─ Rolling update foodiguard-api Pod
             └─ Rolling update foodiguard-web Pod
```

## 4. Main GCP Resources

| Area | Resource | Role |
|---|---|---|
| CI/CD | Jenkins VM on Compute Engine | Builds and deploys containers |
| Image registry | Artifact Registry | Stores Docker images |
| Runtime | GKE Cluster | Runs frontend/backend Pods |
| Public entry | LoadBalancer Service | Provides public IP for web access |
| Internal API | ClusterIP Service | Routes frontend API requests to backend |
| Schema migration | Kubernetes Job | Updates the database before application rollout |
| Database | Cloud SQL PostgreSQL | Stores products, nutrition and ingredient data |
| DB access | Cloud SQL Proxy sidecar | Provides secure DB connection from backend Pod |
| IAM | Workload Identity / Service Accounts | Allows backend Pod to access Cloud SQL securely |
| AI | Vertex AI Gemini 3.5 Flash | Generates natural-language explanations |

## 5. Security Notes

- Do not commit real `.env` files, DB passwords, service account keys, or Cloud SQL credentials.
- Use Kubernetes Secrets or Secret Manager for runtime secrets.
- Keep backend Service as `ClusterIP`; expose only the frontend LoadBalancer.
- Use Cloud SQL Proxy with a GCP service account that has `roles/cloudsql.client`.
- Use `/api/health/live` only for process liveness and `/api/health/ready` for DB/schema readiness.
- Never seed demo data from API startup; run it only through the explicit local-only command.
