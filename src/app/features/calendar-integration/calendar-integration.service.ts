import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import {
  catchError,
  distinctUntilChanged,
  first,
  map,
  startWith,
  switchMap,
  tap,
} from 'rxjs/operators';
import { getRelevantEventsForCalendarIntegrationFromIcal } from '../schedule/ical/get-relevant-events-from-ical';
import { CalendarProvider } from '../config/global-config.model';
import { forkJoin, Observable, of } from 'rxjs';
import { T } from '../../t.const';
import { SnackService } from '../../core/snack/snack.service';
import { getStartOfDayTimestamp } from '../../util/get-start-of-day-timestamp';
import { getEndOfDayTimestamp } from '../../util/get-end-of-day-timestamp';
import { CalendarIntegrationEvent } from './calendar-integration.model';
import {
  selectCalendarProviderById,
  selectCalendarProviders,
} from '../config/store/global-config.reducer';
import { fastArrayCompare } from '../../util/fast-array-compare';
import { selectAllCalendarTaskEventIds } from '../tasks/store/task.selectors';
import { loadFromRealLs, saveToRealLs } from '../../core/persistence/local-storage';
import { LS } from '../../core/persistence/storage-keys.const';
import { Store } from '@ngrx/store';
import { ScheduleCalendarMapEntry } from '../schedule/schedule.model';
import { getWorklogStr } from '../../util/get-work-log-str';
import { TaskService } from '../tasks/task.service';

const ONE_MONTHS = 60 * 60 * 1000 * 24 * 31;

@Injectable({
  providedIn: 'root',
})
export class CalendarIntegrationService {
  icalEvents$: Observable<ScheduleCalendarMapEntry[]> = this._store
    .select(selectCalendarProviders)
    .pipe(
      // tap(() => console.log('selectCalendarProviders')),
      distinctUntilChanged(fastArrayCompare),
      switchMap((calendarProviders) => {
        return calendarProviders && calendarProviders.length
          ? forkJoin(
              calendarProviders
                .filter((calProvider) => calProvider.isEnabled)
                .map((calProvider) =>
                  this._requestEventsForSchedule(calProvider).pipe(
                    // tap((v) =>
                    //   console.log('calendarIntegrationService in forkjoin', v),
                    // ),
                    map((itemsForProvider) =>
                      itemsForProvider.filter(
                        (item) => !this.skippedEventIds.includes(item.id),
                      ),
                    ),
                    map((itemsForProvider: CalendarIntegrationEvent[]) => ({
                      itemsForProvider,
                      calProvider,
                    })),
                  ),
                ),
            ).pipe(
              switchMap((resultForProviders) =>
                this._store.select(selectAllCalendarTaskEventIds).pipe(
                  distinctUntilChanged(fastArrayCompare),
                  // tap((val) => console.log('selectAllCalendarTaskEventIds', val)),
                  map((allCalendarTaskEventIds) => {
                    return resultForProviders.map(({ itemsForProvider, calProvider }) => {
                      return {
                        icon: calProvider.icon || null,
                        //   // filter out items already added as tasks
                        items: itemsForProvider.filter(
                          (calEv) => !allCalendarTaskEventIds.includes(calEv.id),
                        ),
                      } as ScheduleCalendarMapEntry;
                    });
                  }),
                ),
              ),
              // tap((v) => console.log('icalEvents$ final', v)),
              tap((val) => {
                saveToRealLs(LS.CAL_EVENTS_CACHE, val);
              }),
            )
          : (of([]) as Observable<ScheduleCalendarMapEntry[]>);
      }),
      startWith(this._getCalProviderFromCache()),
    );

  public readonly skippedEventIds: string[] = [];

  constructor(
    private _http: HttpClient,
    private _snackService: SnackService,
    private _store: Store,
    private _taskService: TaskService,
  ) {
    if (localStorage.getItem(LS.CALENDER_EVENTS_LAST_SKIP_DAY) === getWorklogStr()) {
      try {
        const skippedEvIds = JSON.parse(
          localStorage.getItem(LS.CALENDER_EVENTS_SKIPPED_TODAY) as string,
        );
        this.skippedEventIds = skippedEvIds;
      } catch (e) {}
    }
  }

  async addEventAsTask(calEv: CalendarIntegrationEvent): Promise<void> {
    const getCalProvider = calEv.calProviderId
      ? await this._store
          .select(selectCalendarProviderById, { id: calEv.calProviderId })
          .pipe(first())
          .toPromise()
      : undefined;

    await this._taskService.addAndSchedule(
      calEv.title,
      {
        projectId: getCalProvider?.defaultProjectId || null,
        issueId: calEv.id,
        issueProviderId: calEv.calProviderId,
        issueType: 'CALENDAR',
        timeEstimate: calEv.duration,
        notes: calEv.description || '',
      },
      calEv.start,
    );
    this.skipCalendarEvent(calEv.id);
  }

  skipCalendarEvent(evId: string): void {
    this.skippedEventIds.push(evId);
    localStorage.setItem(
      LS.CALENDER_EVENTS_SKIPPED_TODAY,
      JSON.stringify(this.skippedEventIds),
    );
    localStorage.setItem(LS.CALENDER_EVENTS_LAST_SKIP_DAY, getWorklogStr());
  }

  requestEvents(
    calProvider: CalendarProvider,
    start = getStartOfDayTimestamp(),
    end = getEndOfDayTimestamp(),
  ): Observable<CalendarIntegrationEvent[]> {
    return this._http.get(calProvider.icalUrl, { responseType: 'text' }).pipe(
      map((icalStrData) =>
        getRelevantEventsForCalendarIntegrationFromIcal(
          icalStrData,
          calProvider.id,
          start,
          end,
        ),
      ),
      catchError((err) => {
        console.error(err);
        this._snackService.open({
          type: 'ERROR',
          msg: T.F.CALENDARS.S.CAL_PROVIDER_ERROR,
          translateParams: {
            errTxt: err?.toString() || err?.status || err?.message || 'UNKNOWN :(',
          },
        });
        return of([]);
      }),
    );
  }

  private _requestEventsForSchedule(
    calProvider: CalendarProvider,
  ): Observable<CalendarIntegrationEvent[]> {
    return this.requestEvents(calProvider, Date.now(), Date.now() + ONE_MONTHS);
  }

  private _getCalProviderFromCache(): ScheduleCalendarMapEntry[] {
    const now = Date.now();
    return (
      ((loadFromRealLs(LS.CAL_EVENTS_CACHE) as ScheduleCalendarMapEntry[]) || [])
        // filter out cached past entries
        .map((provider) => ({
          ...provider,
          items: provider.items.filter((item) => item.start + item.duration >= now),
        }))
    );
  }
}
