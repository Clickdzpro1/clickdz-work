import { useQuery } from '@affine/admin/use-query';
import type { FeatureType, GraphQLQuery } from '@affine/graphql';
import { listUsersQuery } from '@affine/graphql';
import { useEffect, useMemo, useState } from 'react';

export type SuspendedFilter = 'all' | 'active' | 'suspended';

export const useUserList = (filter?: {
  keyword?: string;
  features?: FeatureType[];
  suspendedFilter?: SuspendedFilter;
  dateAfter?: string;
  dateBefore?: string;
}) => {
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: 10,
  });
  const filterKey = useMemo(
    () =>
      `${filter?.keyword ?? ''}-${[...(filter?.features ?? [])]
        .sort()
        .join(',')}-${filter?.suspendedFilter ?? 'all'}-${filter?.dateAfter ?? ''}-${filter?.dateBefore ?? ''}`,
    [
      filter?.features,
      filter?.keyword,
      filter?.suspendedFilter,
      filter?.dateAfter,
      filter?.dateBefore,
    ]
  );

  useEffect(() => {
    setPagination(prev => ({ ...prev, pageIndex: 0 }));
  }, [filterKey]);

  // The new filter fields (disabled, after, before) are not yet in the
  // generated @affine/graphql codegen types. We cast the query + variables
  // through GraphQLQuery to pass them through. The backend resolver accepts
  // these fields (ListUserInput in user/resolver.ts).
  const {
    data: { users, usersCount },
  } = useQuery(
    {
      query: listUsersQuery as GraphQLQuery,
      variables: {
        filter: {
          first: pagination.pageSize,
          skip: pagination.pageIndex * pagination.pageSize,
          keyword: filter?.keyword || undefined,
          features:
            filter?.features && filter.features.length > 0
              ? filter.features
              : undefined,
          disabled:
            filter?.suspendedFilter === 'suspended'
              ? true
              : filter?.suspendedFilter === 'active'
              ? false
              : undefined,
          after: filter?.dateAfter
            ? new Date(filter.dateAfter).toISOString()
            : undefined,
          before: filter?.dateBefore
            ? new Date(filter.dateBefore).toISOString()
            : undefined,
        },
      },
    } as Parameters<typeof useQuery>[0],
    { keepPreviousData: true }
  );

  return {
    users,
    pagination,
    setPagination,
    usersCount,
  };
};
