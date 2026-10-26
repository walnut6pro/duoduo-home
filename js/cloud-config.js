/* cloud-config.js —— 云端配置占位
 * 当前默认本地模式（local）。当真实云服务启用后，由部署/发布流程把
 * publicConfig 注入本文件（endpoint / publishableKey / oauthRelayBaseUrl），
 * 并将 CLOUD_MODE 改为 'cloud'，应用会自动切换到云端同步，无需改动业务代码。
 * 注意：此处只放公开配置（publishableKey 不含任何权限，仅供前端初始化），
 *       绝不写入任何密钥或长期令牌。
 */
window.CLOUD_CONFIG = window.CLOUD_CONFIG || null; // 形如 { endpoint, publishableKey, oauthRelayBaseUrl }
window.CLOUD_MODE = window.CLOUD_MODE || 'local';  // 'cloud' | 'local'
