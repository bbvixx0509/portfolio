import pytest

from app.domain.checklist import (
    calculate_completion_transition,
    calculate_item_numbers,
    normalize_flow_progress,
)
from app.domain.errors import InvalidOperation


def test_current_item_completion_advances_to_first_unfinished_item() -> None:
    transition = calculate_completion_transition(
        item_order=["one", "two", "three"],
        completion_by_id={"one": False, "two": False, "three": False},
        current_item_id="one",
        target_item_id="one",
        is_completed=True,
    )

    assert transition.changed_item_ids == ("one",)
    assert transition.current_item_id == "two"


def test_last_item_completion_clears_current_item() -> None:
    transition = calculate_completion_transition(
        item_order=["one", "two"],
        completion_by_id={"one": True, "two": False},
        current_item_id="two",
        target_item_id="two",
        is_completed=True,
    )

    assert transition.current_item_id is None


def test_unchecking_completed_item_resets_it_and_all_following_items() -> None:
    transition = calculate_completion_transition(
        item_order=["one", "two", "three"],
        completion_by_id={"one": True, "two": True, "three": False},
        current_item_id="three",
        target_item_id="one",
        is_completed=False,
    )

    assert transition.changed_item_ids == ("one", "two", "three")
    assert transition.current_item_id == "one"


def test_future_item_cannot_be_completed() -> None:
    with pytest.raises(InvalidOperation, match="current item"):
        calculate_completion_transition(
            item_order=["one", "two"],
            completion_by_id={"one": False, "two": False},
            current_item_id="one",
            target_item_id="two",
            is_completed=True,
        )


def test_active_flow_edit_preserves_ids_and_normalizes_completion_prefix() -> None:
    progress = normalize_flow_progress(
        ["one", "new-item", "two", "three"],
        {"one": True, "two": True, "three": True},
        preserve_existing=True,
    )

    assert progress.completion_by_id == {
        "one": True,
        "new-item": False,
        "two": False,
        "three": False,
    }
    assert progress.current_item_id == "new-item"


def test_draft_flow_edit_resets_all_completion_values() -> None:
    progress = normalize_flow_progress(
        ["one", "two"],
        {"one": True, "two": True},
        preserve_existing=False,
    )

    assert progress.completion_by_id == {"one": False, "two": False}
    assert progress.current_item_id == "one"


def test_item_numbers_use_chapter_and_local_item_order() -> None:
    numbers = calculate_item_numbers(
        [
            {"id": "chapter-b", "order": 20},
            {"id": "chapter-a", "order": 10},
        ],
        [
            {"id": "a-second", "chapterId": "chapter-a", "order": 9},
            {"id": "b-first", "chapterId": "chapter-b", "order": 30},
            {"id": "a-first", "chapterId": "chapter-a", "order": 2},
        ],
    )

    assert numbers == {
        "a-first": "1.1",
        "a-second": "1.2",
        "b-first": "2.1",
    }
