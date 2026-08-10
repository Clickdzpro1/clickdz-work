import type { FeatureType } from '@affine/graphql';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Header } from '../header';
import { BulkActionBar } from './components/bulk-action-bar';
import { useColumns } from './components/columns';
import { DataTable } from './components/data-table';
import type { SuspendedFilter } from './components/data-table-toolbar';
import type { UserType } from './schema';
import { useUserList } from './use-user-list';

export function AccountPage() {
  const [keyword, setKeyword] = useState('');
  const [featureFilters, setFeatureFilters] = useState<FeatureType[]>([]);
  const [suspendedFilter, setSuspendedFilter] =
    useState<SuspendedFilter>('all');
  const [dateAfter, setDateAfter] = useState('');
  const [dateBefore, setDateBefore] = useState('');
  const { users, pagination, setPagination, usersCount } = useUserList({
    keyword,
    features: featureFilters,
    suspendedFilter,
    dateAfter,
    dateBefore,
  });
  // Remember the user temporarily, because userList is paginated on the server side,can't get all users at once.
  const [memoUsers, setMemoUsers] = useState<UserType[]>([]);

  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(
    new Set<string>()
  );
  const columns = useColumns({ setSelectedUserIds });

  useEffect(() => {
    setMemoUsers(prev => {
      const map = new Map(prev.map(user => [user.id, user]));
      users.forEach(user => {
        map.set(user.id, user);
      });
      return Array.from(map.values());
    });
  }, [users]);

  useEffect(() => {
    setMemoUsers([]);
    setSelectedUserIds(new Set<string>());
  }, [featureFilters, keyword, suspendedFilter, dateAfter, dateBefore]);

  const selectedUsers = useMemo(() => {
    return memoUsers.filter(user => selectedUserIds.has(user.id));
  }, [selectedUserIds, memoUsers]);

  const handleClearSelection = useCallback(() => {
    setSelectedUserIds(new Set<string>());
  }, []);

  return (
    <div className="h-dvh flex-1 flex-col flex">
      <Header title="Accounts" />

      <div className="flex flex-col gap-2 p-2">
        {selectedUsers.length > 0 && (
          <BulkActionBar
            selectedUsers={selectedUsers}
            onClearSelection={handleClearSelection}
          />
        )}
      </div>

      <DataTable
        data={users}
        columns={columns}
        pagination={pagination}
        usersCount={usersCount}
        onPaginationChange={setPagination}
        selectedUsers={selectedUsers}
        keyword={keyword}
        onKeywordChange={setKeyword}
        selectedFeatures={featureFilters}
        onFeaturesChange={setFeatureFilters}
        suspendedFilter={suspendedFilter}
        onSuspendedFilterChange={setSuspendedFilter}
        dateAfter={dateAfter}
        onDateAfterChange={setDateAfter}
        dateBefore={dateBefore}
        onDateBeforeChange={setDateBefore}
      />
    </div>
  );
}
export { AccountPage as Component };
