export const messages = {
  en: {
    title: 'Workspaces', add: 'Add workspace', search: 'Search workspaces and chat titles', filter: 'Filter chats', active: 'Active', pinned: 'Pinned', archived: 'Archived',
    empty: 'No workspaces yet', noMatches: 'No matching workspaces or chats', noFiltered: 'No chats in this view', noChats: 'No chats yet', loading: 'Loading workspaces…',
    connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', error: 'Connection failed', reconnect: 'Reconnect', refresh: 'Refresh', catalogError: 'Workspaces unavailable',
    expand: 'Expand', collapse: 'Collapse', actions: 'Actions', newChat: 'New chat', untitled: 'Untitled chat', rename: 'Rename', forget: 'Remove from Workspaces',
    forgetHint: 'Remove this workspace from the list? Files on the computer are kept.', remove: 'Remove', cancel: 'Cancel', close: 'Close', save: 'Save',
    pin: 'Pin', unpin: 'Unpin', archive: 'Archive', restore: 'Restore', failed: 'This action could not be completed.', running: 'Running', dismiss: 'Dismiss',
    archiveRunning: 'Stop and archive chat?', archiveRunningHint: 'This chat has running work. Archiving stops its running tasks, jobs and subagents.', stopAndArchive: 'Stop and archive',
    showMore: 'Show more', remaining: 'remaining',
  },
  zh: {
    title: '工作区', add: '添加工作区', search: '搜索工作区和会话标题', filter: '筛选会话', active: '未归档', pinned: '已置顶', archived: '已归档',
    empty: '暂无工作区', noMatches: '没有匹配的工作区或会话', noFiltered: '此视图下暂无会话', noChats: '暂无会话', loading: '正在加载工作区…',
    connected: '已连接', connecting: '正在连接…', disconnected: '未连接', error: '连接失败', reconnect: '重新连接', refresh: '刷新', catalogError: '工作区暂时不可用',
    expand: '展开', collapse: '折叠', actions: '操作', newChat: '新会话', untitled: '未命名会话', rename: '重命名', forget: '从工作区移除',
    forgetHint: '从列表移除此工作区？电脑上的文件会保留。', remove: '移除', cancel: '取消', close: '关闭', save: '保存',
    pin: '置顶', unpin: '取消置顶', archive: '归档', restore: '恢复', failed: '操作未完成。', running: '运行中', dismiss: '关闭提示',
    archiveRunning: '停止并归档会话？', archiveRunningHint: '此会话仍有工作在运行。归档会停止其正在运行的任务、作业和子代理。', stopAndArchive: '停止并归档',
    showMore: '显示更多', remaining: '项未显示',
  },
}
export type Translate = (key: keyof typeof messages.en) => string
