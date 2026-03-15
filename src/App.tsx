import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Calendar,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FolderKanban,
  Moon,
  Plus,
  Sun,
  Trash2,
} from 'lucide-react';
import {
  addYears,
  addDays,
  addMonths,
  eachMonthOfInterval,
  differenceInCalendarDays,
  endOfYear,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isSameMonth,
  parseISO,
  startOfYear,
  startOfMonth,
  startOfWeek,
  subYears,
  subMonths,
} from 'date-fns';

type Task = {
  id: string;
  name: string;
  totalHours: number;
  dailyHours: number;
  deadline: string;
  color: string;
  isExternalAnchor: boolean;
  anchorEventName: string;
};

type TaskDraft = {
  name: string;
  totalHours: string;
  dailyHours: string;
  deadline: string;
  isExternalAnchor: boolean;
  anchorEventName: string;
};

type DayEntry = {
  taskId: string;
  taskName: string;
  hours: number;
  color: string;
};

type DaySchedule = {
  date: string;
  entries: DayEntry[];
  totalHours: number;
  overloaded: boolean;
};

type TaskAnalysis = {
  taskId: string;
  plannedFinishDate: string;
  delayed: boolean;
  requiredDailyHours: number;
};

type CalendarEvent = {
  id: string;
  date: string;
  title: string;
  start: string;
  end: string;
  hours: number;
  source: 'auto' | 'anchor';
  color: string;
};

type TaskSettlement = {
  id: string;
  taskId: string;
  date: string;
  actualHours: number;
  adjustmentHours: number;
};

const TASKS_STORAGE_KEY = 'task_scheduler_tasks_v1';
const CAPACITY_STORAGE_KEY = 'task_scheduler_capacity_v1';
const THEME_STORAGE_KEY = 'task_scheduler_theme_v1';
const SETTLEMENTS_STORAGE_KEY = 'task_scheduler_settlements_v1';
const COLOR_POOL = ['#0ea5e9', '#f97316', '#22c55e', '#8b5cf6', '#eab308', '#ef4444'];

const toMinutes = (timeText: string): number => {
  const [hourText, minuteText] = timeText.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return 0;
  }
  return hour * 60 + minute;
};

const toTimeText = (minutes: number): string => {
  const safe = Math.max(0, Math.round(minutes));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const loadTasksFromStorage = (): Task[] => {
  try {
    const raw = localStorage.getItem(TASKS_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as Task[];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter(
        (task) =>
          typeof task.id === 'string' &&
          typeof task.name === 'string' &&
          typeof task.totalHours === 'number' &&
          typeof task.dailyHours === 'number' &&
          typeof task.deadline === 'string' &&
          typeof task.color === 'string'
      )
      .map((task) => ({
        ...task,
        isExternalAnchor: Boolean((task as Partial<Task>).isExternalAnchor),
        anchorEventName:
          typeof (task as Partial<Task>).anchorEventName === 'string'
            ? ((task as Partial<Task>).anchorEventName as string)
            : (task as Task).name,
      }));
  } catch {
    return [];
  }
};

const loadCapacityFromStorage = (): number => {
  try {
    const raw = localStorage.getItem(CAPACITY_STORAGE_KEY);
    if (!raw) {
      return 8;
    }

    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
  } catch {
    return 8;
  }
};

const loadThemeFromStorage = (): 'day' | 'night' => {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    return raw === 'night' ? 'night' : 'day';
  } catch {
    return 'day';
  }
};

const loadSettlementsFromStorage = (): TaskSettlement[] => {
  try {
    const raw = localStorage.getItem(SETTLEMENTS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as TaskSettlement[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (item) =>
        typeof item.id === 'string' &&
        typeof item.taskId === 'string' &&
        typeof item.date === 'string' &&
        typeof item.actualHours === 'number' &&
        typeof item.adjustmentHours === 'number'
    );
  } catch {
    return [];
  }
};

const buildSchedule = (
  tasks: Task[],
  dailyCapacity: number,
  today: Date,
  remainingByTaskId: Map<string, number>
) => {
  const map = new Map<string, DaySchedule>();
  const taskAnalyses: TaskAnalysis[] = [];
  const orderedTasks = [...tasks].sort((a, b) => {
    if (a.isExternalAnchor !== b.isExternalAnchor) {
      return a.isExternalAnchor ? -1 : 1;
    }
    return a.deadline.localeCompare(b.deadline);
  });

  orderedTasks.forEach((task) => {
    const effectiveRemaining = Math.max(0, remainingByTaskId.get(task.id) ?? task.totalHours);
    let remaining = effectiveRemaining;
    let cursor = today;
    let finishDate = today;

    while (remaining > 0) {
      const allocated = Math.min(task.dailyHours, remaining);
      const dayKey = format(cursor, 'yyyy-MM-dd');
      const targetDay = map.get(dayKey);

      if (targetDay) {
        targetDay.entries.push({
          taskId: task.id,
          taskName: task.name,
          hours: allocated,
          color: task.color,
        });
        targetDay.totalHours += allocated;
      } else {
        map.set(dayKey, {
          date: dayKey,
          entries: [
            {
              taskId: task.id,
              taskName: task.name,
              hours: allocated,
              color: task.color,
            },
          ],
          totalHours: allocated,
          overloaded: false,
        });
      }

      remaining -= allocated;
      finishDate = cursor;
      cursor = addDays(cursor, 1);
    }

    const deadlineDate = parseISO(task.deadline);
    const daysUntilDeadline = differenceInCalendarDays(deadlineDate, today) + 1;
    const requiredDailyHours = daysUntilDeadline > 0 ? effectiveRemaining / daysUntilDeadline : effectiveRemaining;

    taskAnalyses.push({
      taskId: task.id,
      plannedFinishDate: format(finishDate, 'yyyy-MM-dd'),
      delayed: isAfter(finishDate, deadlineDate),
      requiredDailyHours,
    });
  });

  map.forEach((day) => {
    day.overloaded = day.totalHours > dailyCapacity;
  });

  const orderedDays = Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  return { map, orderedDays, taskAnalyses };
};

const buildAutoEvents = (scheduleMap: Map<string, DaySchedule>): CalendarEvent[] => {
  const result: CalendarEvent[] = [];

  scheduleMap.forEach((day) => {
    let cursor = 9 * 60;
    day.entries.forEach((entry, index) => {
      const durationMinutes = Math.max(15, Math.round(entry.hours * 60));
      const start = toTimeText(cursor);
      const end = toTimeText(cursor + durationMinutes);
      cursor += durationMinutes;

      result.push({
        id: `auto-${day.date}-${entry.taskId}-${index}`,
        date: day.date,
        title: entry.taskName,
        start,
        end,
        hours: entry.hours,
        source: 'auto',
        color: entry.color,
      });
    });
  });

  return result;
};

const buildAnchorEvents = (tasks: Task[]): CalendarEvent[] => {
  return tasks
    .filter((task) => task.isExternalAnchor)
    .map((task) => ({
      id: `anchor-${task.id}`,
      date: task.deadline,
      title: task.anchorEventName || task.name,
      start: '09:00',
      end: '09:15',
      hours: 0,
      source: 'anchor',
      color: '#f59e0b',
    }));
};

const App = () => {
  const [today] = useState(() => new Date());
  const todayKey = format(today, 'yyyy-MM-dd');
  const [tasks, setTasks] = useState<Task[]>(() => loadTasksFromStorage());
  const [dailyCapacity, setDailyCapacity] = useState<number>(() => loadCapacityFromStorage());
  const [selectedDate, setSelectedDate] = useState(todayKey);
  const [currentMonth, setCurrentMonth] = useState(startOfMonth(today));
  const [calendarView, setCalendarView] = useState<'month' | 'year'>('month');
  const [theme, setTheme] = useState<'day' | 'night'>(() => loadThemeFromStorage());
  const [isInputOpen, setIsInputOpen] = useState<boolean>(true);
  const [taskSettlements, setTaskSettlements] = useState<TaskSettlement[]>(() => loadSettlementsFromStorage());
  const [activeQueueTaskId, setActiveQueueTaskId] = useState<string | null>(null);
  const [settlementDrafts, setSettlementDrafts] = useState<Record<string, { date: string; actualHours: string; adjustmentHours: string }>>({});
  const [draft, setDraft] = useState<TaskDraft>({
    name: '',
    totalHours: '',
    dailyHours: '',
    deadline: todayKey,
    isExternalAnchor: false,
    anchorEventName: '',
  });

  const taskMetricsById = useMemo(() => {
    const map = new Map<string, { actualDone: number; variableChange: number; remaining: number }>();
    tasks.forEach((task) => {
      const logs = taskSettlements.filter((item) => item.taskId === task.id);
      const actualDone = logs.reduce((sum, item) => sum + item.actualHours, 0);
      const variableChange = logs.reduce((sum, item) => sum + item.adjustmentHours, 0);
      const remaining = Math.max(0, task.totalHours + variableChange - actualDone);
      map.set(task.id, { actualDone, variableChange, remaining });
    });
    return map;
  }, [tasks, taskSettlements]);

  const remainingByTaskId = useMemo(() => {
    const map = new Map<string, number>();
    taskMetricsById.forEach((value, key) => {
      map.set(key, value.remaining);
    });
    return map;
  }, [taskMetricsById]);

  const schedulableTasks = useMemo(
    () => tasks.filter((task) => !task.isExternalAnchor),
    [tasks]
  );

  const { map: scheduleMap, taskAnalyses } = useMemo(
    () => buildSchedule(schedulableTasks, dailyCapacity, today, remainingByTaskId),
    [schedulableTasks, dailyCapacity, today, remainingByTaskId]
  );

  useEffect(() => {
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
  }, [tasks]);

  useEffect(() => {
    localStorage.setItem(CAPACITY_STORAGE_KEY, String(dailyCapacity));
  }, [dailyCapacity]);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SETTLEMENTS_STORAGE_KEY, JSON.stringify(taskSettlements));
  }, [taskSettlements]);

  const gridStart = startOfWeek(startOfMonth(currentMonth), { weekStartsOn: 1 });
  const gridEnd = endOfWeek(endOfMonth(currentMonth), { weekStartsOn: 1 });
  const dayCells: Date[] = [];
  let cursor = gridStart;

  while (cursor <= gridEnd) {
    dayCells.push(cursor);
    cursor = addDays(cursor, 1);
  }

  const autoEvents = useMemo(() => buildAutoEvents(scheduleMap), [scheduleMap]);
  const anchorEvents = useMemo(() => buildAnchorEvents(tasks), [tasks]);

  const allEventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();

    autoEvents.forEach((item) => {
      const existing = map.get(item.date) ?? [];
      existing.push(item);
      map.set(item.date, existing);
    });

    anchorEvents.forEach((item) => {
      const existing = map.get(item.date) ?? [];
      existing.push(item);
      map.set(item.date, existing);
    });

    map.forEach((items, key) => {
      const ordered = [...items].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
      map.set(key, ordered);
    });

    return map;
  }, [autoEvents, anchorEvents]);

  const todayLoad = scheduleMap.get(todayKey)?.totalHours ?? 0;
  const queueTasks = tasks.filter((task) => {
    if (task.isExternalAnchor) {
      return false;
    }
    const metrics = taskMetricsById.get(task.id);
    return (metrics?.remaining ?? task.totalHours) > 0;
  });
  const completedTasks = tasks.filter((task) => {
    if (task.isExternalAnchor) {
      return false;
    }
    const metrics = taskMetricsById.get(task.id);
    return (metrics?.remaining ?? task.totalHours) <= 0;
  });
  const anchorOnlyTasks = tasks.filter((task) => task.isExternalAnchor);

  useEffect(() => {
    if (queueTasks.length === 0) {
      setActiveQueueTaskId(null);
      return;
    }

    const stillExists = activeQueueTaskId && queueTasks.some((task) => task.id === activeQueueTaskId);
    if (!stillExists) {
      setActiveQueueTaskId(queueTasks[0].id);
    }
  }, [queueTasks, activeQueueTaskId]);

  const allWorkDates = useMemo(() => {
    const set = new Set<string>();
    Array.from(scheduleMap.keys()).forEach((dateKey) => set.add(dateKey));
    return Array.from(set.values());
  }, [scheduleMap]);

  const overloadedDays = allWorkDates.filter((dateKey) => {
    const taskHours = scheduleMap.get(dateKey)?.totalHours ?? 0;
    return taskHours > dailyCapacity;
  }).length;

  const delayedTasks = taskAnalyses.filter((analysis) => analysis.delayed).length;

  let healthLevel: 'Green' | 'Yellow' | 'Red' = 'Green';
  if (delayedTasks > 0 || overloadedDays > 2) {
    healthLevel = 'Red';
  } else if (overloadedDays > 0) {
    healthLevel = 'Yellow';
  }

  const healthClassMap: Record<'Green' | 'Yellow' | 'Red', string> = {
    Green: 'bg-emerald-100 text-emerald-700',
    Yellow: 'bg-amber-100 text-amber-700',
    Red: 'bg-rose-100 text-rose-700',
  };

  const weeklyLoad = Array.from({ length: 7 }).reduce<number>((sum, _, index) => {
    const key = format(addDays(today, index), 'yyyy-MM-dd');
    return sum + (scheduleMap.get(key)?.totalHours ?? 0);
  }, 0);

  const projectInputInsight = useMemo(() => {
    const totalHours = Number(draft.totalHours);
    const plannedDaily = Number(draft.dailyHours);
    if (!Number.isFinite(totalHours) || !Number.isFinite(plannedDaily) || !draft.deadline) {
      return null;
    }

    if (totalHours <= 0 || plannedDaily <= 0) {
      return null;
    }

    const deadline = parseISO(draft.deadline);
    const daysLeft = Math.max(1, differenceInCalendarDays(deadline, today) + 1);
    const minDaily = totalHours / daysLeft;
    const mustDays = Math.max(1, daysLeft - 2);
    const mustDaily = draft.isExternalAnchor ? totalHours / mustDays : minDaily;
    const projectedDays = Math.ceil(totalHours / plannedDaily);
    const projectedDate = format(addDays(today, Math.max(0, projectedDays - 1)), 'yyyy-MM-dd');
    const onTrack = !isAfter(addDays(today, Math.max(0, projectedDays - 1)), deadline);

    return {
      minDaily,
      mustDaily,
      projectedDate,
      onTrack,
      isExternalAnchor: draft.isExternalAnchor,
    };
  }, [draft, today]);

  const yearMonths = useMemo(
    () =>
      eachMonthOfInterval({
        start: startOfYear(currentMonth),
        end: endOfYear(currentMonth),
      }),
    [currentMonth]
  );

  const monthMetrics = useMemo(() => {
    const map = new Map<string, { events: number; hours: number; overloadedDays: number }>();

    allEventsByDate.forEach((events, dateKey) => {
      const monthKey = dateKey.slice(0, 7);
      const current = map.get(monthKey) ?? { events: 0, hours: 0, overloadedDays: 0 };
      const dayHours = events.reduce((sum, item) => sum + item.hours, 0);
      current.events += events.length;
      current.hours += dayHours;
      if (dayHours > dailyCapacity) {
        current.overloadedDays += 1;
      }
      map.set(monthKey, current);
    });

    return map;
  }, [allEventsByDate, dailyCapacity]);

  const addTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const totalHours = Number(draft.totalHours);
    const dailyHours = Number(draft.dailyHours);

    if (!draft.name.trim() || !Number.isFinite(totalHours) || !Number.isFinite(dailyHours) || !draft.deadline) {
      return;
    }

    if (totalHours <= 0 || dailyHours <= 0) {
      return;
    }

    const newTask: Task = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: draft.name.trim(),
      totalHours,
      dailyHours,
      deadline: draft.deadline,
      color: COLOR_POOL[tasks.length % COLOR_POOL.length],
      isExternalAnchor: draft.isExternalAnchor,
      anchorEventName: draft.anchorEventName.trim() || draft.name.trim(),
    };

    setTasks((prev) => [...prev, newTask]);
    setDraft({
      name: '',
      totalHours: '',
      dailyHours: '',
      deadline: todayKey,
      isExternalAnchor: false,
      anchorEventName: '',
    });
  };

  const updateTaskField = (taskId: string, field: 'totalHours' | 'dailyHours' | 'deadline', value: string) => {
    setTasks((prev) =>
      prev.map((task) => {
        if (task.id !== taskId) {
          return task;
        }

        if (field === 'deadline') {
          return { ...task, deadline: value };
        }

        const parsed = Number(value);
        if (!Number.isFinite(parsed) || parsed <= 0) {
          return task;
        }

        return { ...task, [field]: parsed };
      })
    );
  };

  const settleTaskForSelectedDate = (taskId: string) => {
    const draftValue = settlementDrafts[taskId] ?? { date: selectedDate, actualHours: '', adjustmentHours: '' };
    const actualHours = Number(draftValue.actualHours || 0);
    const adjustmentHours = Number(draftValue.adjustmentHours || 0);

    if (!Number.isFinite(actualHours) || !Number.isFinite(adjustmentHours)) {
      return;
    }
    if (actualHours === 0 && adjustmentHours === 0) {
      return;
    }

    const newSettlement: TaskSettlement = {
      id: `settle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      date: draftValue.date || selectedDate,
      actualHours,
      adjustmentHours,
    };

    setTaskSettlements((prev) => [...prev, newSettlement]);
    setSettlementDrafts((prev) => ({
      ...prev,
      [taskId]: { date: draftValue.date || selectedDate, actualHours: '', adjustmentHours: '' },
    }));
  };

  const removeTask = (taskId: string) => {
    setTasks((prev) => prev.filter((task) => task.id !== taskId));
    setTaskSettlements((prev) => prev.filter((item) => item.taskId !== taskId));
    setSettlementDrafts((prev) => {
      const next = { ...prev };
      delete next[taskId];
      return next;
    });
  };

  return (
    <div className={[
      'relative min-h-screen overflow-hidden px-4 py-8 md:px-8',
      theme === 'night'
        ? 'dream-night bg-[radial-gradient(circle_at_20%_20%,_#334155_0%,_#1e1b4b_32%,_#0f172a_64%,_#020617_100%)] text-slate-100'
        : 'bg-[radial-gradient(circle_at_20%_20%,_#fbcfe8_0%,_#e9d5ff_22%,_#dbeafe_45%,_#f8fafc_72%)] text-slate-900',
    ].join(' ')}>
      <div className="dream-orb dream-orb-a" aria-hidden="true" />
      <div className="dream-orb dream-orb-b" aria-hidden="true" />
      <div className="dream-orb dream-orb-c" aria-hidden="true" />
      <main className="mx-auto flex w-full max-w-none flex-col gap-3">
        <div className="dream-fade-up flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-white/70 bg-white/50 px-3 py-2 shadow-[0_14px_30px_-20px_rgba(91,33,182,0.45)] backdrop-blur-xl">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-[9999px] bg-slate-900 px-2.5 py-1 font-semibold text-white">TODAY {todayKey}</span>
            <span className="rounded-[9999px] bg-fuchsia-100 px-2.5 py-1 font-semibold text-fuchsia-700">ACTIVE {tasks.length}</span>
            <span className="rounded-[9999px] bg-rose-100 px-2.5 py-1 font-semibold text-rose-700">RISK {delayedTasks + overloadedDays}</span>
            <span className="rounded-[9999px] bg-cyan-100 px-2.5 py-1 font-semibold text-cyan-700">LOAD {todayLoad.toFixed(1)}h/{dailyCapacity}h</span>
          </div>
          <button
            type="button"
            onClick={() => setTheme((prev) => (prev === 'night' ? 'day' : 'night'))}
            className="inline-flex items-center gap-1.5 rounded-[9999px] border border-white/70 bg-white/60 px-3 py-1.5 text-xs font-semibold tracking-wide text-slate-700 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:bg-white/80"
          >
            {theme === 'night' ? <Sun size={14} /> : <Moon size={14} />}
            {theme === 'night' ? '切换白昼' : '切换星夜'}
          </button>
        </div>

        <div className="grid h-[calc(100vh-132px)] min-h-[600px] gap-4 overflow-hidden lg:grid-cols-[320px_1fr]">
          <section className="dream-fade-up h-full overflow-y-auto rounded-3xl border border-white/70 bg-white/55 p-4 shadow-[0_20px_45px_-30px_rgba(91,33,182,0.55)] backdrop-blur-xl" style={{ animationDelay: '90ms' }}>
          <div className="mb-4 flex items-center gap-3 border-b border-slate-200/80 pb-3">
            <div className="rounded-xl bg-gradient-to-br from-fuchsia-100 to-sky-100 p-2 text-fuchsia-700 ring-1 ring-fuchsia-200">
              <FolderKanban size={18} />
            </div>
            <div>
              <h1 className="bg-gradient-to-r from-fuchsia-700 via-violet-700 to-cyan-700 bg-clip-text text-xl font-bold tracking-tight text-transparent">本地项目排程工具</h1>
              <p className="text-xs text-slate-600">自动排程、冲突检测、延期预测</p>
            </div>
          </div>

          <div className="mb-2">
            <button
              type="button"
              onClick={() => setIsInputOpen((prev) => !prev)}
              className="flex w-full items-center justify-between rounded-xl border border-fuchsia-100 bg-white/70 px-3 py-2 text-left"
            >
              <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-600">Project Input</span>
              <ChevronDown size={16} className={isInputOpen ? 'rotate-180 transition' : 'transition'} />
            </button>
          </div>

          {isInputOpen && <form onSubmit={addTask} className="space-y-2 rounded-2xl bg-gradient-to-br from-white/70 via-fuchsia-50/70 to-cyan-50/70 p-3 ring-1 ring-fuchsia-100">
            <label className="block text-sm font-medium text-slate-700">
              项目名称
              <input
                value={draft.name}
                onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-fuchsia-200 bg-white/90 px-2.5 py-1.5 text-sm outline-none ring-fuchsia-300 transition focus:border-fuchsia-400 focus:ring"
                placeholder="例如：官网改版"
              />
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-slate-700">
                预估总工时
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={draft.totalHours}
                  onChange={(event) => setDraft((prev) => ({ ...prev, totalHours: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-fuchsia-200 bg-white/90 px-2.5 py-1.5 text-sm outline-none ring-fuchsia-300 transition focus:border-fuchsia-400 focus:ring"
                  placeholder="40"
                />
              </label>
              <label className="block text-sm font-medium text-slate-700">
                每日投入时长
                <input
                  type="number"
                  min={0.5}
                  step={0.5}
                  value={draft.dailyHours}
                  onChange={(event) => setDraft((prev) => ({ ...prev, dailyHours: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-fuchsia-200 bg-white/90 px-2.5 py-1.5 text-sm outline-none ring-fuchsia-300 transition focus:border-fuchsia-400 focus:ring"
                  placeholder="4"
                />
              </label>
            </div>

            <label className="block text-sm font-medium text-slate-700">
              截止日期（Deadline）
              <input
                type="date"
                value={draft.deadline}
                onChange={(event) => setDraft((prev) => ({ ...prev, deadline: event.target.value }))}
                className="mt-1 w-full rounded-lg border border-fuchsia-200 bg-white/90 px-2.5 py-1.5 text-sm outline-none ring-fuchsia-300 transition focus:border-fuchsia-400 focus:ring"
              />
            </label>

            <label className="flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <span className="font-medium">锚点事件</span>
              <input
                type="checkbox"
                checked={draft.isExternalAnchor}
                onChange={(event) => setDraft((prev) => ({ ...prev, isExternalAnchor: event.target.checked }))}
                className="h-4 w-4 accent-amber-500"
              />
            </label>

            {draft.isExternalAnchor && (
              <label className="block text-sm font-medium text-slate-700">
                锚点事件名称
                <input
                  value={draft.anchorEventName}
                  onChange={(event) => setDraft((prev) => ({ ...prev, anchorEventName: event.target.value }))}
                  className="mt-1 w-full rounded-lg border border-amber-200 bg-white/90 px-2.5 py-1.5 text-sm outline-none ring-amber-300 transition focus:border-amber-400 focus:ring"
                  placeholder="例如：客户评审会"
                />
              </label>
            )}

            {projectInputInsight && (
              <div className="rounded-lg border border-cyan-100 bg-cyan-50 px-3 py-2 text-xs text-cyan-800">
                <p>
                  推荐最小日投入: <span className="font-bold">{projectInputInsight.minDaily.toFixed(2)}h/天</span>
                </p>
                {projectInputInsight.isExternalAnchor && (
                  <p className="mt-1 text-amber-700">
                    必须达成值: <span className="font-bold">{projectInputInsight.mustDaily.toFixed(2)}h/天</span>（外部锚点前完成前置准备）
                  </p>
                )}
                <p className="mt-1">
                  按你填写的 {Number(draft.dailyHours || 0).toFixed(2)}h/天，预计完成: <span className="font-bold">{projectInputInsight.projectedDate}</span>
                  <span className={projectInputInsight.onTrack ? 'ml-1 font-semibold text-emerald-700' : 'ml-1 font-semibold text-rose-700'}>
                    {projectInputInsight.onTrack ? '可按时' : '可能延期'}
                  </span>
                </p>
              </div>
            )}

            <button
              type="submit"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-fuchsia-600 via-violet-600 to-cyan-600 px-3 py-2 text-sm font-semibold text-white shadow-lg shadow-fuchsia-300/45 transition hover:-translate-y-0.5 hover:brightness-110"
            >
              <Plus size={16} />
              添加项目
            </button>
          </form>}

          <div className="mt-3 space-y-2">
            <div className="flex items-center justify-between rounded-xl border border-fuchsia-100 bg-white/80 px-3 py-2 shadow-sm">
              <div className="inline-flex items-center gap-2 text-sm font-medium text-slate-700">
                <Activity size={16} />
                每日容量上限
              </div>
              <input
                type="number"
                min={1}
                step={0.5}
                value={dailyCapacity}
                onChange={(event) => setDailyCapacity(Math.max(1, Number(event.target.value) || 1))}
                className="w-20 rounded-lg border border-fuchsia-200 bg-white/90 px-2 py-1 text-right text-sm"
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              <article className="rounded-xl bg-white/85 p-3 shadow-sm ring-1 ring-fuchsia-100">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">当前总负荷</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{todayLoad.toFixed(1)}h / {dailyCapacity}h</p>
                <p className="text-[11px] text-slate-500">7天均值 {(weeklyLoad / 7).toFixed(1)}h/天</p>
              </article>
              <article className="rounded-xl bg-white/85 p-3 shadow-sm ring-1 ring-cyan-100">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500">项目健康度</p>
                <p className={`mt-2 inline-flex rounded-[9999px] px-3 py-1 text-sm font-semibold ${healthClassMap[healthLevel]}`}>
                  {healthLevel}
                </p>
                <p className="mt-2 text-xs text-slate-500">冲突日 {overloadedDays} 天，延期项目 {delayedTasks} 个</p>
              </article>
            </div>

            {anchorOnlyTasks.length > 0 && (
              <article className="rounded-xl bg-white/85 p-3 shadow-sm ring-1 ring-amber-100">
                <p className="text-xs font-medium uppercase tracking-wide text-amber-700">锚点管理</p>
                <div className="mt-2 max-h-28 space-y-1 overflow-y-auto pr-1 text-xs">
                  {anchorOnlyTasks.map((task) => (
                    <div key={task.id} className="flex items-center justify-between rounded-lg border border-amber-100 bg-amber-50 px-2 py-1">
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-amber-900">{task.anchorEventName || task.name}</p>
                        <p className="text-[10px] text-amber-700">{task.deadline}</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => removeTask(task.id)}
                        className="rounded p-1 text-amber-700 transition hover:bg-amber-100"
                        aria-label="删除锚点事件"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            )}

            {completedTasks.length > 0 && (
              <article className="rounded-xl bg-white/85 p-3 shadow-sm ring-1 ring-emerald-100">
                <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">已完成项目</p>
                <div className="mt-2 max-h-32 space-y-1 overflow-y-auto pr-1 text-xs">
                  {completedTasks.map((task) => {
                    const metrics = taskMetricsById.get(task.id) ?? {
                      actualDone: 0,
                      variableChange: 0,
                      remaining: 0,
                    };
                    return (
                      <div key={task.id} className="flex items-center justify-between rounded-lg border border-emerald-100 bg-emerald-50 px-2 py-1">
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-emerald-900">{task.name}</p>
                          <p className="text-[10px] text-emerald-700">
                            实际 {metrics.actualDone.toFixed(1)}h / 变化 {metrics.variableChange >= 0 ? '+' : ''}{metrics.variableChange.toFixed(1)}h
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeTask(task.id)}
                          className="rounded p-1 text-emerald-700 transition hover:bg-emerald-100"
                          aria-label="删除已完成项目"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </article>
            )}

          </div>

          </section>

          <section className="dream-fade-up h-full overflow-y-auto rounded-3xl border border-white/70 bg-white/55 p-4 shadow-[0_20px_45px_-30px_rgba(14,116,144,0.5)] backdrop-blur-xl" style={{ animationDelay: '180ms' }}>
          <div className="sticky top-0 z-10 mb-3 flex items-center justify-between border-b border-slate-200/80 bg-white/65 pb-3 pt-1 backdrop-blur">
            <button
              type="button"
              onClick={() =>
                setCurrentMonth((prev) =>
                  calendarView === 'month' ? subMonths(prev, 1) : subYears(prev, 1)
                )
              }
              className="rounded-xl border border-fuchsia-200 bg-white/80 px-3 py-2 text-fuchsia-700 transition hover:-translate-y-0.5 hover:bg-fuchsia-50"
              aria-label={calendarView === 'month' ? '上个月' : '上一年'}
            >
              <ChevronLeft size={16} />
            </button>

            <div className="inline-flex items-center gap-2 text-lg font-semibold text-violet-800">
              <Calendar size={18} />
              {calendarView === 'month' ? format(currentMonth, 'yyyy 年 MM 月') : format(currentMonth, 'yyyy 年')}
            </div>

            <button
              type="button"
              onClick={() =>
                setCurrentMonth((prev) =>
                  calendarView === 'month' ? addMonths(prev, 1) : addYears(prev, 1)
                )
              }
              className="rounded-xl border border-fuchsia-200 bg-white/80 px-3 py-2 text-fuchsia-700 transition hover:-translate-y-0.5 hover:bg-fuchsia-50"
              aria-label={calendarView === 'month' ? '下个月' : '下一年'}
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-lg border border-fuchsia-200 bg-white/70 p-1 text-xs font-semibold">
              <button
                type="button"
                onClick={() => setCalendarView('month')}
                className={[
                  'rounded-md px-3 py-1.5 transition',
                  calendarView === 'month' ? 'bg-fuchsia-600 text-white' : 'text-fuchsia-700 hover:bg-fuchsia-50',
                ].join(' ')}
              >
                月视图
              </button>
              <button
                type="button"
                onClick={() => setCalendarView('year')}
                className={[
                  'rounded-md px-3 py-1.5 transition',
                  calendarView === 'year' ? 'bg-fuchsia-600 text-white' : 'text-fuchsia-700 hover:bg-fuchsia-50',
                ].join(' ')}
              >
                年视图
              </button>
            </div>
            <span className="text-xs text-slate-500">年视图展示当前年份 12 个月</span>
          </div>

          {calendarView === 'month' && <div className="mb-2 grid grid-cols-7 gap-2 text-center text-xs font-semibold uppercase tracking-wide text-slate-500">
            {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((name) => (
              <div key={name}>{name}</div>
            ))}
          </div>}

          {calendarView === 'month' && <div className="grid grid-cols-7 gap-2">
            {dayCells.map((day) => {
              const dayKey = format(day, 'yyyy-MM-dd');
              const daySchedule = scheduleMap.get(dayKey);
              const isSelected = selectedDate === dayKey;
              const taskHours = daySchedule?.totalHours ?? 0;
              const dayTotalHours = taskHours;
              const overload = dayTotalHours > dailyCapacity;
              const dayEvents = allEventsByDate.get(dayKey) ?? [];

              return (
                <button
                  key={dayKey}
                  type="button"
                  onClick={() => setSelectedDate(dayKey)}
                  className={[
                    'relative aspect-[4/3] min-h-[104px] max-h-[132px] overflow-hidden rounded-xl border p-2 text-left transition hover:-translate-y-0.5 hover:shadow-sm',
                    isSelected ? 'border-fuchsia-400 ring-2 ring-fuchsia-200 shadow-sm' : 'border-fuchsia-100',
                    isSameMonth(day, currentMonth) ? 'bg-white/90' : 'bg-slate-50/70 text-slate-400',
                    overload ? 'border-rose-300 bg-rose-50/90' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold">{format(day, 'd')}</span>
                    {taskHours > 0 && <span className="text-[11px] text-slate-500">{dayTotalHours.toFixed(1)}h</span>}
                  </div>
                  <div className="mt-2 max-h-[72px] space-y-1 overflow-y-auto pr-0.5">
                    {dayEvents.map((entry, index) => (
                      <div
                        key={`${entry.id}-${index}`}
                        className={[
                          'dream-chip max-w-full truncate rounded px-1.5 py-0.5 text-[10px] font-medium',
                          entry.source === 'anchor'
                            ? 'border border-amber-300 border-dashed text-amber-900 brightness-95'
                            : 'text-white',
                        ].join(' ')}
                        style={{
                          backgroundColor: entry.source === 'anchor' ? '#fef3c7' : entry.color,
                        }}
                        title={entry.title}
                      >
                        {entry.title}
                      </div>
                    ))}
                  </div>
                </button>
              );
            })}
          </div>}

          {calendarView === 'year' && (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {yearMonths.map((monthDate) => {
                const monthKey = format(monthDate, 'yyyy-MM');
                const metrics = monthMetrics.get(monthKey) ?? { events: 0, hours: 0, overloadedDays: 0 };
                return (
                  <button
                    key={monthKey}
                    type="button"
                    onClick={() => {
                      setCurrentMonth(startOfMonth(monthDate));
                      setCalendarView('month');
                    }}
                    className="rounded-xl border border-fuchsia-100 bg-white/85 p-3 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-fuchsia-300"
                  >
                    <p className="text-sm font-bold text-violet-800">{format(monthDate, 'MM 月')}</p>
                    <p className="mt-1 text-xs text-slate-500">{format(monthDate, 'yyyy')}</p>
                    <div className="mt-2 space-y-1 text-xs">
                      <p className="text-slate-700">事件: {metrics.events}</p>
                      <p className="text-slate-700">工时: {metrics.hours.toFixed(1)}h</p>
                      <p className={metrics.overloadedDays > 0 ? 'text-rose-600' : 'text-emerald-600'}>
                        超载日: {metrics.overloadedDays}
                      </p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div className="mt-5 rounded-2xl bg-gradient-to-br from-white/75 via-fuchsia-50/70 to-cyan-50/80 p-4 ring-1 ring-fuchsia-100">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-700">Project Queue</h2>
              <p className="text-xs text-slate-500">记录日期: {selectedDate}</p>
            </div>

            {queueTasks.length === 0 ? (
              <p className="text-sm text-slate-500">暂无非锚点项目。</p>
            ) : (
              (() => {
                const activeTask = queueTasks.find((task) => task.id === activeQueueTaskId) ?? queueTasks[0];
                const activeAnalysis = taskAnalyses.find((item) => item.taskId === activeTask.id);
                const delayed = activeAnalysis?.delayed ?? false;
                const metrics = taskMetricsById.get(activeTask.id) ?? {
                  actualDone: 0,
                  variableChange: 0,
                  remaining: activeTask.totalHours,
                };
                const scopeHours = Math.max(1, activeTask.totalHours + Math.max(0, metrics.variableChange));
                const doneRatio = Math.min(100, (metrics.actualDone / scopeHours) * 100);
                const scopeRatio = Math.min(100, (activeTask.totalHours / scopeHours) * 100);
                const changeRatio = Math.min(100, (Math.abs(metrics.variableChange) / scopeHours) * 100);
                const trendText = metrics.variableChange > 0 ? '膨胀' : metrics.variableChange < 0 ? '缩减' : '稳定';
                const daysLeft = Math.max(1, differenceInCalendarDays(parseISO(activeTask.deadline), today) + 1);
                const futureAvg = metrics.remaining / daysLeft;
                const history = taskSettlements
                  .filter((item) => item.taskId === activeTask.id)
                  .sort((a, b) => a.date.localeCompare(b.date));

                return (
                  <div className="space-y-3">
                    <div className="overflow-x-auto pb-1">
                      <div className="inline-flex min-w-full gap-2">
                        {queueTasks.map((task) => {
                          const isActive = task.id === activeTask.id;
                          const taskMetrics = taskMetricsById.get(task.id) ?? {
                            actualDone: 0,
                            variableChange: 0,
                            remaining: task.totalHours,
                          };
                          return (
                            <button
                              key={task.id}
                              type="button"
                              onClick={() => setActiveQueueTaskId(task.id)}
                              className={[
                                'min-w-[160px] rounded-lg border px-3 py-2 text-left transition',
                                isActive
                                  ? 'border-fuchsia-400 bg-white text-fuchsia-700 shadow-sm'
                                  : 'border-fuchsia-100 bg-white/70 text-slate-600 hover:border-fuchsia-300 hover:bg-white',
                              ].join(' ')}
                            >
                              <p className="truncate text-xs font-semibold" style={{ color: isActive ? task.color : undefined }}>{task.name}</p>
                              <p className="mt-1 text-[10px] text-slate-500">剩余 {taskMetrics.remaining.toFixed(1)}h</p>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <article key={activeTask.id} className="rounded-xl bg-white/90 p-3 shadow-sm ring-1 ring-fuchsia-100">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold" style={{ color: activeTask.color }}>{activeTask.name}</p>
                          <p className="mt-1 text-[11px] text-slate-500">
                            初始输入: 总工时 {activeTask.totalHours.toFixed(1)}h / 每日 {activeTask.dailyHours.toFixed(1)}h / DDL {activeTask.deadline}
                          </p>
                          <p className="mt-1 text-[11px] text-slate-600">
                            剩余 {metrics.remaining.toFixed(1)}h, 未来平均需 {futureAvg.toFixed(2)}h/天
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeTask(activeTask.id)}
                          className="rounded-lg p-1.5 text-slate-500 transition hover:bg-fuchsia-100 hover:text-fuchsia-700"
                          aria-label="删除项目"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        <label className="text-[11px] text-slate-500">
                          总工时
                          <input
                            type="number"
                            min={0.5}
                            step={0.5}
                            defaultValue={activeTask.totalHours}
                            onBlur={(event) => updateTaskField(activeTask.id, 'totalHours', event.target.value)}
                            className="mt-1 w-full rounded-md border border-fuchsia-200 bg-white px-2 py-1 text-xs"
                          />
                        </label>
                        <label className="text-[11px] text-slate-500">
                          每日投入
                          <input
                            type="number"
                            min={0.5}
                            step={0.5}
                            defaultValue={activeTask.dailyHours}
                            onBlur={(event) => updateTaskField(activeTask.id, 'dailyHours', event.target.value)}
                            className="mt-1 w-full rounded-md border border-fuchsia-200 bg-white px-2 py-1 text-xs"
                          />
                        </label>
                        <label className="text-[11px] text-slate-500">
                          DDL
                          <input
                            type="date"
                            defaultValue={activeTask.deadline}
                            onBlur={(event) => updateTaskField(activeTask.id, 'deadline', event.target.value)}
                            className="mt-1 w-full rounded-md border border-fuchsia-200 bg-white px-2 py-1 text-xs"
                          />
                        </label>
                      </div>

                      <div className="mt-2 rounded-lg bg-slate-50 p-2 ring-1 ring-slate-200">
                        <div className="mb-1 flex items-center justify-between text-[11px] text-slate-600">
                          <span>趋势: {trendText}</span>
                          <span>预计完成 {activeAnalysis?.plannedFinishDate ?? '-'}</span>
                        </div>
                        <div className="h-2 overflow-hidden rounded-[9999px] bg-slate-200">
                          <div className="h-full bg-violet-400" style={{ width: `${scopeRatio}%` }} />
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-[9999px] bg-slate-200">
                          <div className="h-full bg-emerald-400" style={{ width: `${doneRatio}%` }} />
                        </div>
                        <div className="mt-1 h-2 overflow-hidden rounded-[9999px] bg-slate-200">
                          <div
                            className={metrics.variableChange >= 0 ? 'h-full bg-rose-400' : 'h-full bg-cyan-400'}
                            style={{ width: `${changeRatio}%` }}
                          />
                        </div>
                        <div className="mt-1 grid grid-cols-3 gap-1 text-[10px] text-slate-600">
                          <span>Total</span>
                          <span className="text-emerald-700">Actual {metrics.actualDone.toFixed(1)}h</span>
                          <span className={metrics.variableChange >= 0 ? 'text-rose-700' : 'text-cyan-700'}>
                            Change {metrics.variableChange >= 0 ? '+' : ''}{metrics.variableChange.toFixed(1)}h
                          </span>
                        </div>
                      </div>

                      <div className="mt-2 grid gap-2 sm:grid-cols-[120px_1fr_1fr_auto]">
                        <input
                          type="date"
                          value={settlementDrafts[activeTask.id]?.date ?? selectedDate}
                          onChange={(event) =>
                            setSettlementDrafts((prev) => ({
                              ...prev,
                              [activeTask.id]: {
                                date: event.target.value,
                                actualHours: prev[activeTask.id]?.actualHours ?? '',
                                adjustmentHours: prev[activeTask.id]?.adjustmentHours ?? '',
                              },
                            }))
                          }
                          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
                        />
                        <input
                          type="number"
                          step={0.5}
                          placeholder="实际工作量(h)"
                          value={settlementDrafts[activeTask.id]?.actualHours ?? ''}
                          onChange={(event) =>
                            setSettlementDrafts((prev) => ({
                              ...prev,
                              [activeTask.id]: {
                                date: prev[activeTask.id]?.date ?? selectedDate,
                                actualHours: event.target.value,
                                adjustmentHours: prev[activeTask.id]?.adjustmentHours ?? '',
                              },
                            }))
                          }
                          className="rounded-md border border-emerald-200 bg-white px-2 py-1 text-xs"
                        />
                        <input
                          type="number"
                          step={0.5}
                          placeholder="追加/调整(h)"
                          value={settlementDrafts[activeTask.id]?.adjustmentHours ?? ''}
                          onChange={(event) =>
                            setSettlementDrafts((prev) => ({
                              ...prev,
                              [activeTask.id]: {
                                date: prev[activeTask.id]?.date ?? selectedDate,
                                actualHours: prev[activeTask.id]?.actualHours ?? '',
                                adjustmentHours: event.target.value,
                              },
                            }))
                          }
                          className="rounded-md border border-amber-200 bg-white px-2 py-1 text-xs"
                        />
                        <button
                          type="button"
                          onClick={() => settleTaskForSelectedDate(activeTask.id)}
                          className="rounded-md bg-slate-900 px-2 py-1 text-xs font-semibold text-white hover:bg-slate-700"
                        >
                          记录
                        </button>
                      </div>

                      <div className="mt-2 rounded-lg bg-white p-2 ring-1 ring-slate-200">
                        <p className="text-[11px] font-semibold text-slate-600">每日执行记录</p>
                        {history.length === 0 ? (
                          <p className="mt-1 text-[11px] text-slate-400">暂无记录</p>
                        ) : (
                          <div className="mt-1 max-h-24 space-y-1 overflow-y-auto pr-1 text-[11px]">
                            {history.map((item) => (
                              <div key={item.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1">
                                <span className="text-slate-600">{item.date}</span>
                                <span className="text-emerald-700">做了 {item.actualHours.toFixed(1)}h</span>
                                <span className={item.adjustmentHours >= 0 ? 'text-rose-700' : 'text-cyan-700'}>
                                  变更 {item.adjustmentHours >= 0 ? '+' : ''}{item.adjustmentHours.toFixed(1)}h
                                </span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      {delayed && activeAnalysis && (
                        <div className="mt-2 rounded-lg bg-rose-50 p-2 text-xs text-rose-700 ring-1 ring-rose-200">
                          <div className="inline-flex items-center gap-1 font-semibold">
                            <AlertTriangle size={13} />
                            延期警告
                          </div>
                          <p className="mt-1">按当前投入将晚于 DDL。若要按时完成，至少需要 {activeAnalysis.requiredDailyHours.toFixed(2)}h/天。</p>
                        </div>
                      )}
                    </article>
                  </div>
                );
              })()
            )}
          </div>
          </section>
        </div>
      </main>
    </div>
  );
};

export default App;
