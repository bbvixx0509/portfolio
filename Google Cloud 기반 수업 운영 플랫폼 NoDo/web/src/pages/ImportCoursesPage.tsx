import { ArrowDownWideNarrow, Plus, Search } from "lucide-react";
import { type ChangeEvent, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { CourseImportRow } from "../components/import/CourseImportRow";
import { ImportHeader } from "../components/import/ImportHeader";
import {
  getImportCourseCounts,
  importCourseMocks,
  type ImportCourse,
  type ImportCourseStatus,
} from "../data/importPageMocks";
import styles from "./ImportCoursesPage.module.css";

type CourseFilter = "ALL" | ImportCourseStatus;
type CourseSort = "RECENT" | "OLDEST" | "NAME";

const sortLabels: Record<CourseSort, string> = {
  RECENT: "최근 사용순",
  OLDEST: "오래된 사용순",
  NAME: "이름순",
};

function normalizeSearch(value: string) {
  return value.trim().toLocaleLowerCase("ko-KR");
}

function matchesFilter(course: ImportCourse, filter: CourseFilter) {
  return filter === "ALL" || course.status === filter;
}

function matchesSearch(course: ImportCourse, query: string) {
  const normalizedQuery = normalizeSearch(query);
  return (
    normalizedQuery.length === 0 ||
    course.title.toLocaleLowerCase("ko-KR").includes(normalizedQuery)
  );
}

function isVisibleCourse(
  course: ImportCourse,
  query: string,
  filter: CourseFilter,
) {
  return matchesFilter(course, filter) && matchesSearch(course, query);
}

export function ImportCoursesPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<CourseFilter>("ALL");
  const [sort, setSort] = useState<CourseSort>("RECENT");
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null);

  const counts = useMemo(() => getImportCourseCounts(importCourseMocks), []);
  const selectedCourse = importCourseMocks.find(
    (course) => course.id === selectedCourseId,
  );

  const visibleCourses = useMemo(() => {
    const filteredCourses = importCourseMocks.filter((course) =>
      isVisibleCourse(course, query, filter),
    );

    return filteredCourses.sort((first, second) => {
      if (sort === "NAME") {
        return first.title.localeCompare(second.title, "ko-KR");
      }

      const timeDifference =
        Date.parse(first.lastUsedAt) - Date.parse(second.lastUsedAt);
      return sort === "OLDEST" ? timeDifference : -timeDifference;
    });
  }, [filter, query, sort]);

  const filterOptions: ReadonlyArray<{
    value: CourseFilter;
    label: string;
    count: number;
  }> = [
    { value: "ALL", label: "전체", count: counts.total },
    {
      value: "IN_PROGRESS",
      label: "이어서 진행 중",
      count: counts.inProgress,
    },
    { value: "COMPLETED", label: "완료", count: counts.completed },
  ];

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>) {
    const nextQuery = event.target.value;
    setQuery(nextQuery);

    if (
      selectedCourse &&
      !isVisibleCourse(selectedCourse, nextQuery, filter)
    ) {
      setSelectedCourseId(null);
    }
  }

  function handleFilterChange(nextFilter: CourseFilter) {
    setFilter(nextFilter);

    if (
      selectedCourse &&
      !isVisibleCourse(selectedCourse, query, nextFilter)
    ) {
      setSelectedCourseId(null);
    }
  }

  function handleImport() {
    if (!selectedCourse) {
      return;
    }

    navigate(`/courses/${selectedCourse.id}/prepare`);
  }

  return (
    <div className={styles.page}>
      <ImportHeader />

      <main className={styles.main}>
        <section className={styles.intro} aria-labelledby="import-title">
          <p className={styles.step}>STEP 00 · 불러오기</p>
          <h1 className={styles.title} id="import-title">
            만들었던 로드맵을 <span>다시</span> 불러와요
          </h1>
          <p className={styles.subtitle}>
            이어서 진행하거나, 그대로 복사해서 새 강의에 쓸 수 있어요
          </p>
        </section>

        <section className={styles.catalog} aria-label="기존 강의 목록">
          <div className={styles.toolbar}>
            <label className={styles.searchField}>
              <Search aria-hidden="true" size={20} strokeWidth={2.5} />
              <span className={styles.srOnly}>강의명으로 검색</span>
              <input
                type="search"
                value={query}
                onChange={handleSearchChange}
                placeholder="강의명으로 검색"
                aria-label="강의명으로 검색"
              />
            </label>

            <label
              className={styles.sortControl}
              title={`목록 정렬: ${sortLabels[sort]}`}
            >
              <ArrowDownWideNarrow
                aria-hidden="true"
                size={21}
                strokeWidth={2.2}
              />
              <span className={styles.srOnly}>목록 정렬</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as CourseSort)
                }
                aria-label="목록 정렬"
              >
                <option value="RECENT">최근 사용순</option>
                <option value="OLDEST">오래된 사용순</option>
                <option value="NAME">이름순</option>
              </select>
            </label>

            <div
              className={styles.filters}
              role="group"
              aria-label="강의 상태 필터"
            >
              {filterOptions.map((option) => (
                <button
                  key={option.value}
                  className={styles.filterButton}
                  type="button"
                  aria-pressed={filter === option.value}
                  onClick={() => handleFilterChange(option.value)}
                >
                  {option.label} {option.count}
                </button>
              ))}
            </div>
          </div>

          {visibleCourses.length > 0 ? (
            <div
              className={styles.courseList}
              role="radiogroup"
              aria-label="기존 목록 선택"
            >
              {visibleCourses.map((course) => (
                <CourseImportRow
                  key={course.id}
                  course={course}
                  selected={selectedCourseId === course.id}
                  onSelect={setSelectedCourseId}
                />
              ))}
            </div>
          ) : (
            <div
              className={styles.emptyState}
              role="status"
              aria-label="검색 결과 없음"
            >
              <strong>검색 조건에 맞는 강의가 없어요</strong>
              <span>다른 강의명이나 상태 필터를 선택해 주세요.</span>
            </div>
          )}
        </section>

        <section className={styles.actions} aria-label="목록 불러오기 동작">
          <Link className={styles.createLink} to="/create/manual">
            <Plus aria-hidden="true" size={16} strokeWidth={2.5} />
            새로 만들기
          </Link>

          <p className={styles.selectionSummary} aria-live="polite">
            {selectedCourse ? (
              <>
                선택된 강의 · <strong>{selectedCourse.title}</strong>
              </>
            ) : (
              "불러올 목록을 선택해 주세요"
            )}
          </p>

          <button
            className={styles.importButton}
            type="button"
            disabled={!selectedCourse}
            onClick={handleImport}
          >
            이 목록 불러오기
          </button>
        </section>
      </main>
    </div>
  );
}
