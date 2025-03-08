import type { ActorMethod } from "@dfinity/agent";
import type { Principal } from "@dfinity/principal";

export interface AddCategoryArgs {
  args: Array<Category>;
}
export interface AddNewsArgs {
  args: Array<News>;
}
export interface AddTagArgs {
  args: Array<Tag>;
}
export interface ArchiveData {
  end: bigint;
  stored_news: bigint;
  start: bigint;
  canister: ArchiveInterface;
}
export interface ArchiveInterface {
  append_news: ActorMethod<[Array<News>], Result_8>;
  get_news: ActorMethod<[bigint], Result_5>;
  query_news: ActorMethod<[NewsRequest], NewsRange>;
  remaining_capacity: ActorMethod<[], Result>;
  total_news: ActorMethod<[], Result>;
}
export interface ArchivedNews {
  callback: QueryArchivedNewsFn;
  start: bigint;
  length: bigint;
}
export interface Category {
  metadata: [] | [Value];
  name: string;
}
export type Error =
  | { NotController: null }
  | { CommonError: null }
  | { InvalidRequest: null }
  | { InternalError: string };
export interface News {
  id: [] | [string];
  title: string;
  provider: Value;
  metadata: Value;
  hash: string;
  tags: Array<string>;
  description: string;
  created_at: bigint;
  category: string;
  index: bigint;
}
export interface NewsRange {
  news: Array<News>;
}
export interface NewsRequest {
  start: bigint;
  length: bigint;
}
export interface NewsResponse {
  news: Array<News>;
  first_index: bigint;
  length: bigint;
  archived_news: Array<ArchivedNews>;
}
export type QueryArchivedNewsFn = ActorMethod<[NewsRequest], NewsRange>;
export type Result = { ok: bigint } | { err: Error };
export type Result_1 = { ok: Array<News> } | { err: Error };
export type Result_2 = { ok: [boolean, string] } | { err: Error };
export type Result_3 = { ok: Array<Tag> } | { err: Error };
export type Result_4 = { ok: Array<[Principal, string]> } | { err: Error };
export type Result_5 = { ok: News } | { err: Error };
export type Result_6 = { ok: Array<Category> } | { err: Error };
export type Result_7 = { ok: Array<ArchiveData> } | { err: Error };
export type Result_8 = { ok: boolean } | { err: Error };
export interface Tag {
  metadata: [] | [Value];
  name: string;
}
export type Value =
  | { Int: bigint }
  | { Map: Array<[string, Value]> }
  | { Nat: bigint }
  | { Blob: Uint8Array | number[] }
  | { Bool: boolean }
  | { Text: string }
  | { Float: number }
  | { Principal: Principal }
  | { Array: Array<Value> };
export interface _SERVICE {
  get_archives: ActorMethod<[], Result_7>;
  get_categories: ActorMethod<[], Result_6>;
  get_news_by_hash: ActorMethod<[string], Result_5>;
  get_news_by_index: ActorMethod<[bigint], Result_5>;
  get_news_by_time: ActorMethod<[bigint, bigint], Result_1>;
  get_providers: ActorMethod<[], Result_4>;
  get_tags: ActorMethod<[], Result_3>;
  get_task_status: ActorMethod<[], Result_2>;
  query_latest_news: ActorMethod<[bigint], Result_1>;
  query_news: ActorMethod<[NewsRequest], NewsResponse>;
  total_news: ActorMethod<[], Result>;
}
export const idlFactory = ({ IDL }: any) => {
  const Value = IDL.Rec();
  Value.fill(
    IDL.Variant({
      Int: IDL.Int,
      Map: IDL.Vec(IDL.Tuple(IDL.Text, Value)),
      Nat: IDL.Nat,
      Blob: IDL.Vec(IDL.Nat8),
      Bool: IDL.Bool,
      Text: IDL.Text,
      Float: IDL.Float64,
      Principal: IDL.Principal,
      Array: IDL.Vec(Value),
    })
  );
  const Category = IDL.Record({
    metadata: IDL.Opt(Value),
    name: IDL.Text,
  });
  // eslint-disable-next-line no-unused-vars
  const AddCategoryArgs = IDL.Record({ args: IDL.Vec(Category) });
  const Error = IDL.Variant({
    NotController: IDL.Null,
    CommonError: IDL.Null,
    InvalidRequest: IDL.Null,
    InternalError: IDL.Text,
  });
  const Result_8 = IDL.Variant({ ok: IDL.Bool, err: Error });
  const News = IDL.Record({
    id: IDL.Opt(IDL.Text),
    title: IDL.Text,
    provider: Value,
    metadata: Value,
    hash: IDL.Text,
    tags: IDL.Vec(IDL.Text),
    description: IDL.Text,
    created_at: IDL.Nat,
    category: IDL.Text,
    index: IDL.Nat,
  });
  // eslint-disable-next-line no-unused-vars
  const AddNewsArgs = IDL.Record({ args: IDL.Vec(News) });
  const Tag = IDL.Record({ metadata: IDL.Opt(Value), name: IDL.Text });
  // eslint-disable-next-line no-unused-vars
  const AddTagArgs = IDL.Record({ args: IDL.Vec(Tag) });
  const Result_5 = IDL.Variant({ ok: News, err: Error });
  const NewsRequest = IDL.Record({ start: IDL.Nat, length: IDL.Nat });
  const NewsRange = IDL.Record({ news: IDL.Vec(News) });
  const Result = IDL.Variant({ ok: IDL.Nat, err: Error });
  const ArchiveInterface = IDL.Service({
    append_news: IDL.Func([IDL.Vec(News)], [Result_8], []),
    get_news: IDL.Func([IDL.Nat], [Result_5], ["query"]),
    query_news: IDL.Func([NewsRequest], [NewsRange], ["query"]),
    remaining_capacity: IDL.Func([], [Result], ["query"]),
    total_news: IDL.Func([], [Result], ["query"]),
  });
  const ArchiveData = IDL.Record({
    end: IDL.Nat,
    stored_news: IDL.Nat,
    start: IDL.Nat,
    canister: ArchiveInterface,
  });
  const Result_7 = IDL.Variant({ ok: IDL.Vec(ArchiveData), err: Error });
  const Result_6 = IDL.Variant({ ok: IDL.Vec(Category), err: Error });
  const Result_1 = IDL.Variant({ ok: IDL.Vec(News), err: Error });
  const Result_4 = IDL.Variant({
    ok: IDL.Vec(IDL.Tuple(IDL.Principal, IDL.Text)),
    err: Error,
  });
  const Result_3 = IDL.Variant({ ok: IDL.Vec(Tag), err: Error });
  const Result_2 = IDL.Variant({
    ok: IDL.Tuple(IDL.Bool, IDL.Text),
    err: Error,
  });
  const QueryArchivedNewsFn = IDL.Func([NewsRequest], [NewsRange], ["query"]);
  const ArchivedNews = IDL.Record({
    callback: QueryArchivedNewsFn,
    start: IDL.Nat,
    length: IDL.Nat,
  });
  const NewsResponse = IDL.Record({
    news: IDL.Vec(News),
    first_index: IDL.Nat,
    length: IDL.Nat,
    archived_news: IDL.Vec(ArchivedNews),
  });
  return IDL.Service({
    get_archives: IDL.Func([], [Result_7], ["query"]),
    get_categories: IDL.Func([], [Result_6], ["query"]),
    get_news_by_hash: IDL.Func([IDL.Text], [Result_5], ["query"]),
    get_news_by_index: IDL.Func([IDL.Nat], [Result_5], ["composite_query"]),
    get_news_by_time: IDL.Func([IDL.Nat, IDL.Nat], [Result_1], ["query"]),
    get_providers: IDL.Func([], [Result_4], ["query"]),
    get_tags: IDL.Func([], [Result_3], ["query"]),
    get_task_status: IDL.Func([], [Result_2], ["query"]),
    query_latest_news: IDL.Func([IDL.Nat], [Result_1], ["query"]),
    query_news: IDL.Func([NewsRequest], [NewsResponse], ["composite_query"]),
    total_news: IDL.Func([], [Result], ["query"]),
  });
};
export const init = ({ IDL }: any) => {
  return [];
};
