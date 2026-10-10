from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes import router
from app.core.config import settings
from app.domain.errors import DomainError


def create_app() -> FastAPI:
    settings.validate_startup()
    application = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
    )
    application.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    application.include_router(router)

    @application.exception_handler(DomainError)
    async def handle_domain_error(
        _request: Request, error: DomainError
    ) -> JSONResponse:
        content = {"code": error.code, "detail": error.message}
        content.update(getattr(error, "public_details", {}))
        return JSONResponse(
            status_code=error.status_code,
            content=content,
            headers=getattr(error, "headers", None),
        )

    return application


app = create_app()
