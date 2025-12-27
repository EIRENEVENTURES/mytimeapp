# Technical Debt Removal Summary

This document summarizes the technical debt that has been removed from the chat system.

## 1. Separated Business Logic from Socket Layer

**Before**: Socket handlers directly inserted messages into the database and handled business logic.

**After**: Created `messageService.ts` to handle all message persistence and business logic. Socket handlers now delegate to the service layer.

**Files Changed**:
- `backend/src/services/messageService.ts` (new)
- `backend/src/socket.ts` - Removed database queries, uses service
- `backend/src/routes/messages.ts` - Uses service instead of inline logic

**Benefits**:
- Testable business logic
- Reusable message creation logic
- Clear separation of concerns

## 2. Removed ALTER TABLE Statements from Route Handlers

**Before**: Route handlers contained `ALTER TABLE` statements for schema migrations.

**After**: All schema changes are handled through proper migration files only.

**Files Changed**:
- `backend/src/routes/messages.ts` - Removed 3 `ALTER TABLE` statements
- Schema changes now only in `backend/sql/` migration files

**Benefits**:
- No runtime schema modifications
- Predictable database state
- Proper migration tracking

## 3. Centralized File Handling

**Before**: File upload logic duplicated in multiple places with inconsistent validation and size limits.

**After**: Created `fileService.ts` with centralized file handling, validation, and size limits.

**Files Changed**:
- `backend/src/services/fileService.ts` (new)
- `backend/src/routes/messages.ts` - Uses file service
- `backend/src/routes/user.ts` - Uses file service

**Benefits**:
- Consistent file validation
- Centralized size limits and MIME type checking
- Single source of truth for file upload logic
- Removed duplicate `uploadToBlobStorage` function

## 4. Replaced OFFSET Pagination with Cursor-Based

**Before**: User search used `OFFSET` pagination which becomes slow with large datasets.

**After**: Implemented cursor-based pagination using user ID and ratings/display_name for stable ordering.

**Files Changed**:
- `backend/src/routes/user.ts` - Replaced `OFFSET` with cursor-based pagination

**Benefits**:
- Better performance on large datasets
- Stable pagination (no duplicates when data changes)
- Scales better as data grows

## 5. Split Media Handling from Messaging

**Before**: File upload endpoint (`/messages/upload`) handled both file storage and message creation in one handler.

**After**: File upload uses `fileService` for storage and `messageService` for message creation, with clear separation.

**Files Changed**:
- `backend/src/routes/messages.ts` - Upload endpoint now uses services

**Benefits**:
- Clear separation of concerns
- File handling can be reused elsewhere
- Easier to test and maintain

## 6. Reduced Socket Payload Size

**Before**: Socket handlers emitted full message objects.

**After**: Socket handlers emit minimal payloads (message IDs only), requiring clients to fetch full data if needed.

**Files Changed**:
- `backend/src/socket.ts` - Emits `{ id: message.id }` instead of full message
- `backend/src/routes/messages.ts` - `emitMessageToUsers` already uses minimal payload

**Benefits**:
- Reduced network traffic
- Faster socket delivery
- Better scalability

## 7. Removed Unused Code

**Before**: Unused imports, duplicate functions, and deprecated code.

**After**: Cleaned up unused code and consolidated duplicate functionality.

**Files Changed**:
- `backend/src/routes/messages.ts` - Removed duplicate `uploadToBlobStorage`, unused imports
- `backend/src/socket.ts` - Removed unused `getTypingUsers` import

**Benefits**:
- Smaller codebase
- Easier to maintain
- Less confusion

## Summary of New Files

1. **`backend/src/services/messageService.ts`**
   - Handles message creation and persistence
   - Idempotency checking
   - Unread count management

2. **`backend/src/services/fileService.ts`**
   - Centralized file upload logic
   - File validation (size, MIME type)
   - Blob storage and local storage handling

## Remaining Technical Debt (Future Work)

1. **UI Components Doing Data Fetching**: Some React components still fetch data directly instead of using hooks/services
2. **Large Queries**: Some queries could be split further for better performance
3. **Reconciliation**: Could add more explicit reconciliation endpoints for better offline support

## Impact

- **Reduced Complexity**: Business logic separated from transport layer
- **Better Testability**: Services can be tested independently
- **Improved Performance**: Cursor pagination, smaller socket payloads
- **Easier Maintenance**: Centralized file handling, no runtime schema changes
- **Better Scalability**: Cursor pagination, minimal socket payloads

