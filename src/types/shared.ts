/** 知识库条目 */
export interface KnowledgeBase {
  id: string;
  name: string;
  content: string;
  is_builtin: boolean;
  category: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}
