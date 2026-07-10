// Kairos contacts helper (Objective-C, same pattern as calendar-helper).
// Prints the macOS address book as JSON on stdout:
//   [{"name": "...", "org": "...", "phones": ["+52 55 ..."], "emails": ["..."]}]
// Exit codes: 0 ok · 2 contacts access denied · 3 unexpected failure.
// TCC note: permission is attributed to the responsible .app bundle that
// spawned this binary — the Electron app's Info.plist must carry
// NSContactsUsageDescription.

#import <Foundation/Foundation.h>
#import <Contacts/Contacts.h>

int main(void) {
  @autoreleasepool {
    CNContactStore* store = [[CNContactStore alloc] init];
    dispatch_semaphore_t sema = dispatch_semaphore_create(0);
    __block BOOL granted = NO;

    [store requestAccessForEntityType:CNEntityTypeContacts
                    completionHandler:^(BOOL g, NSError* _Nullable err) {
      granted = g;
      dispatch_semaphore_signal(sema);
    }];
    dispatch_semaphore_wait(sema, dispatch_time(DISPATCH_TIME_NOW, 30 * NSEC_PER_SEC));

    if (!granted) {
      fprintf(stderr, "contacts access denied\n");
      return 2;
    }

    NSArray* keys = @[
      CNContactGivenNameKey, CNContactFamilyNameKey, CNContactOrganizationNameKey,
      CNContactPhoneNumbersKey, CNContactEmailAddressesKey
    ];
    CNContactFetchRequest* req = [[CNContactFetchRequest alloc] initWithKeysToFetch:keys];
    NSMutableArray* out = [NSMutableArray array];
    NSError* err = nil;

    BOOL ok = [store enumerateContactsWithFetchRequest:req
                                                 error:&err
                                            usingBlock:^(CNContact* c, BOOL* stop) {
      NSString* name = [[NSString stringWithFormat:@"%@ %@", c.givenName, c.familyName]
          stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceCharacterSet]];
      if (name.length == 0) name = c.organizationName;
      if (name.length == 0) return;

      NSMutableArray* phones = [NSMutableArray array];
      for (CNLabeledValue* lv in c.phoneNumbers) {
        [phones addObject:((CNPhoneNumber*)lv.value).stringValue];
      }
      NSMutableArray* emails = [NSMutableArray array];
      for (CNLabeledValue* lv in c.emailAddresses) {
        [emails addObject:(NSString*)lv.value];
      }
      if (phones.count == 0 && emails.count == 0) return;

      [out addObject:@{
        @"name" : name,
        @"org" : c.organizationName ?: @"",
        @"phones" : phones,
        @"emails" : emails
      }];
    }];

    if (!ok) {
      fprintf(stderr, "fetch failure: %s\n", err.description.UTF8String);
      return 3;
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
