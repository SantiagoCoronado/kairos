// Command Center calendar helper (Objective-C: compiles with bare CLT clang;
// swiftc is unusable on some CLT installs due to the duplicate
// SwiftBridging modulemap bug).
// Prints today's (or --from/--to ISO8601) events as JSON on stdout.
// Exit codes: 0 ok · 2 calendar access denied · 3 unexpected failure.
// TCC note: permission is attributed to the responsible .app bundle that
// spawned this binary — the Electron app's Info.plist must carry the
// calendar usage strings.

#import <Foundation/Foundation.h>
#import <EventKit/EventKit.h>

int main(int argc, const char* argv[]) {
  @autoreleasepool {
    EKEventStore* store = [[EKEventStore alloc] init];
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block BOOL granted = NO;

    if (@available(macOS 14.0, *)) {
      [store requestFullAccessToEventsWithCompletion:^(BOOL g, NSError* _Nullable err) {
        granted = g;
        dispatch_semaphore_signal(sema);
      }];
    } else {
      [store requestAccessToEntityType:EKEntityTypeEvent
                            completion:^(BOOL g, NSError* _Nullable err) {
        granted = g;
        dispatch_semaphore_signal(sema);
      }];
    }
    dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));

    if (!granted) {
      fprintf(stderr, "calendar access denied\n");
      return 2;
    }

    NSISO8601DateFormatter* iso = [[NSISO8601DateFormatter alloc] init];
    NSCalendar* cal = [NSCalendar currentCalendar];
    NSDate* start = [cal startOfDayForDate:[NSDate date]];
    NSDate* end = [cal dateByAddingUnit:NSCalendarUnitDay value:1 toDate:start options:0];

    for (int i = 1; i < argc - 1; i++) {
      if (strcmp(argv[i], "--from") == 0) {
        NSDate* d = [iso dateFromString:@(argv[i + 1])];
        if (d) start = d;
      } else if (strcmp(argv[i], "--to") == 0) {
        NSDate* d = [iso dateFromString:@(argv[i + 1])];
        if (d) end = d;
      }
    }

    NSPredicate* pred = [store predicateForEventsWithStartDate:start endDate:end calendars:nil];
    NSArray<EKEvent*>* events = [[store eventsMatchingPredicate:pred]
        sortedArrayUsingComparator:^NSComparisonResult(EKEvent* a, EKEvent* b) {
          return [a.startDate compare:b.startDate];
        }];

    NSMutableArray* out = [NSMutableArray arrayWithCapacity:events.count];
    for (EKEvent* e in events) {
      [out addObject:@{
        @"title" : e.title ?: @"(untitled)",
        @"start" : [iso stringFromDate:e.startDate],
        @"end" : [iso stringFromDate:e.endDate],
        @"allDay" : @(e.allDay),
        @"calendar" : e.calendar.title ?: @"",
        @"location" : e.location ?: [NSNull null],
      }];
    }

    NSError* jsonErr = nil;
    NSData* json = [NSJSONSerialization dataWithJSONObject:out options:0 error:&jsonErr];
    if (!json) {
      fprintf(stderr, "encode failure: %s\n", jsonErr.description.UTF8String);
      return 3;
    }
    [[NSFileHandle fileHandleWithStandardOutput] writeData:json];
    printf("\n");
    return 0;
  }
}
