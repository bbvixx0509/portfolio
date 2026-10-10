from dataclasses import dataclass

from app.domain.errors import InvalidOperation, ResourceNotFound


@dataclass(frozen=True)
class CompletionTransition:
    changed_item_ids: tuple[str, ...]
    current_item_id: str | None


@dataclass(frozen=True)
class FlowProgress:
    completion_by_id: dict[str, bool]
    current_item_id: str | None


def calculate_item_numbers(
    chapters: list[dict[str, object]], items: list[dict[str, object]]
) -> dict[str, str]:
    """Return stable 1-based chapter.item display numbers from flow ordering."""

    ordered_chapters = sorted(
        chapters,
        key=lambda chapter: (int(chapter.get("order", 0)), str(chapter.get("id", ""))),
    )
    result: dict[str, str] = {}
    for chapter_index, chapter in enumerate(ordered_chapters, start=1):
        chapter_id = str(chapter.get("id", ""))
        chapter_items = sorted(
            (item for item in items if str(item.get("chapterId", "")) == chapter_id),
            key=lambda item: (int(item.get("order", 0)), str(item.get("id", ""))),
        )
        for item_index, item in enumerate(chapter_items, start=1):
            item_id = str(item.get("id", ""))
            if item_id:
                result[item_id] = f"{chapter_index}.{item_index}"
    return result


def normalize_flow_progress(
    item_order: list[str],
    existing_completion: dict[str, bool],
    *,
    preserve_existing: bool,
) -> FlowProgress:
    contiguous = True
    normalized: dict[str, bool] = {}
    for item_id in item_order:
        was_completed = preserve_existing and existing_completion.get(item_id, False)
        is_completed = contiguous and was_completed
        if not is_completed:
            contiguous = False
        normalized[item_id] = is_completed
    current_item_id = next(
        (item_id for item_id in item_order if not normalized[item_id]), None
    )
    return FlowProgress(normalized, current_item_id)


def calculate_completion_transition(
    *,
    item_order: list[str],
    completion_by_id: dict[str, bool],
    current_item_id: str | None,
    target_item_id: str,
    is_completed: bool,
) -> CompletionTransition:
    if target_item_id not in item_order:
        raise ResourceNotFound("Checklist item not found")
    if set(item_order) - completion_by_id.keys():
        raise ResourceNotFound("Checklist flow is incomplete")
    index = item_order.index(target_item_id)
    if is_completed:
        if completion_by_id[target_item_id]:
            raise InvalidOperation("The checklist item is already completed")
        if current_item_id != target_item_id:
            raise InvalidOperation("Only the current item can be completed")
        next_item_id = next(
            (
                item_id
                for item_id in item_order[index + 1 :]
                if not completion_by_id[item_id]
            ),
            None,
        )
        return CompletionTransition((target_item_id,), next_item_id)
    if not completion_by_id[target_item_id]:
        raise InvalidOperation("Only a completed item can be unchecked")
    return CompletionTransition(tuple(item_order[index:]), target_item_id)
