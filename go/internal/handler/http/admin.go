package http

import (
	"encoding/json"
	"log"
	"momo-backend-go/internal/model"
	"momo-backend-go/internal/pkg/utils"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Login 优化后的登录逻辑
func (h *CommentHandler) Login(c *gin.Context) {
	ip := utils.GetClientIP(c)

	// 1. 检查 IP 封禁状态
	if utils.Limiter.IsIPBlocked(ip) {
		log.Printf("[WARN] Blocked IP attempted to login: %s", ip)
		c.JSON(http.StatusForbidden, gin.H{
			"code":    403,
			"message": "IP is blocked due to multiple failed"})
		return
	}

	var req model.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid request body"})
		return
	}

	// 2. 验证凭据
	if !utils.CheckAdminCredentials(req.Name, req.Password) {
		isBlocked := utils.Limiter.RecordAttempt(ip)
		log.Printf("[WARN] Login failed for IP: %s", ip)

		if isBlocked {
			c.JSON(http.StatusForbidden, gin.H{
				"code":    403,
				"message": "IP is blocked due to multiple failed"})
		} else {
			c.JSON(http.StatusUnauthorized, gin.H{
				"code":    401,
				"message": "Invalid username or password"})
		}
		return
	}

	// 3. 登录成功处理
	utils.Limiter.ResetAttempt(ip)
	log.Printf("[INFO] Login successful for IP: %s", ip)

	// 生成密钥并按文档格式返回
	tempKey := utils.GenerateTempKey(req.Name)
	needChangePassword := utils.IsDefaultAdmin()
	c.JSON(http.StatusOK, gin.H{
		"code":               200,
		"message":            "Login successful",
		"token":              tempKey,
		"needChangePassword": needChangePassword,
	})
}

func (h *CommentHandler) GetSettings(c *gin.Context) {
	all := utils.GetAllSettings()

	sensitiveKeys := map[string]bool{
		"admin_password":    true,
		"email_password":    true,
		"admin_comment_key": true,
	}

	allowedSettings := map[string]bool{
		"site_name":                 true,
		"admin_email":               true,
		"admin_name":                true,
		"smtp_host":                 true,
		"smtp_port":                 true,
		"email_user":                true,
		"email_password":            true,
		"email_secure":              true,
		"allow_origin":              true,
		"email_enabled":             true,
		"reply_template":            true,
		"notification_template":     true,
		"comment_auto_approve":      true,
		"ip_blacklist":              true,
		"email_blacklist":           true,
		"blogger_badge_enabled":     true,
		"blogger_badge_text":        true,
		"placeholder_name":          true,
		"placeholder_email":         true,
		"placeholder_content":       true,
		"placeholder_url":           true,
		"admin_comment_key":         true,
		"admin_comment_key_enabled": true,
		"email_verify_enabled":      true,
		"verify_base_url":           true,
		"comment_verify_enabled":    true,
		"comment_verify_difficulty": true,
	}

	// 按模块分组
	settingsGroups := map[string][]string{
		"basic":    {"site_name", "admin_email", "comment_auto_approve", "blogger_badge_enabled", "blogger_badge_text", "placeholder_name", "placeholder_email", "placeholder_content", "placeholder_url"},
		"email":    {"smtp_host", "smtp_port", "email_user", "email_password", "email_secure", "email_enabled", "email_verify_enabled", "verify_base_url", "reply_template", "notification_template"},
		"security": {"allow_origin", "admin_comment_key", "admin_comment_key_enabled", "ip_blacklist", "email_blacklist", "comment_verify_enabled", "comment_verify_difficulty"},
		"account":  {"admin_name"},
	}

	// 支持按 type 参数过滤
	typeParam := c.Query("type")
	var keys []string
	if typeParam != "" {
		if groupKeys, ok := settingsGroups[typeParam]; ok {
			keys = groupKeys
		} else {
			keys = nil
		}
	}
	if keys == nil {
		keys = make([]string, 0, len(allowedSettings))
		for k := range allowedSettings {
			keys = append(keys, k)
		}
	}

	filtered := make(map[string]string)
	for _, key := range keys {
		if val, ok := all[key]; ok {
			if sensitiveKeys[key] {
				filtered[key] = ""
			} else {
				filtered[key] = val
			}
		}
	}
	if _, ok := filtered["email_enabled"]; !ok {
		filtered["email_enabled"] = "true"
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Settings fetched",
		"data":    filtered,
	})
}

func (h *CommentHandler) UpdateSettings(c *gin.Context) {
	var body map[string]string
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid request body",
		})
		return
	}

	allowedSettings := map[string]bool{
		"site_name":                 true,
		"admin_email":               true,
		"admin_name":                true,
		"smtp_host":                 true,
		"smtp_port":                 true,
		"email_user":                true,
		"email_password":            true,
		"email_secure":              true,
		"allow_origin":              true,
		"email_enabled":             true,
		"reply_template":            true,
		"notification_template":     true,
		"comment_auto_approve":      true,
		"ip_blacklist":              true,
		"email_blacklist":           true,
		"blogger_badge_enabled":     true,
		"blogger_badge_text":        true,
		"placeholder_name":          true,
		"placeholder_email":         true,
		"placeholder_content":       true,
		"placeholder_url":           true,
		"admin_comment_key":         true,
		"admin_comment_key_enabled": true,
		"email_verify_enabled":      true,
		"verify_base_url":           true,
		"comment_verify_enabled":    true,
		"comment_verify_difficulty": true,
	}

	for key := range body {
		if !allowedSettings[key] {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    400,
				"message": "Setting \"" + key + "\" is not allowed",
			})
			return
		}
	}

	smtpChanged := body["smtp_host"] != "" || body["smtp_port"] != "" || body["email_user"] != "" || body["email_password"] != ""

	for key, value := range body {
		// Bug fix: 邮箱密码为空时不覆盖已有密码
		if key == "email_password" && value == "" {
			continue
		}
		if err := utils.SetSetting(key, value); err != nil {
			log.Printf("[ERROR] Failed to update setting %s: %v", key, err)
		}
	}

	log.Printf("[INFO] Settings updated by admin: %v", body)
	c.JSON(http.StatusOK, gin.H{
		"code":        200,
		"message":     "Settings updated",
		"smtpChanged": smtpChanged,
	})
}

func (h *CommentHandler) TestEmail(c *gin.Context) {
	adminEmail := utils.GetSetting("admin_email")
	if adminEmail == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Admin email is not configured. ",
		})
		return
	}

	svc := utils.GetService()
	if !svc.IsAvailable() {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "SMTP is not configured. ",
		})
		return
	}

	if !utils.IsEmailEnabled() {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "The email notification feature is currently disabled. ",
		})
		return
	}

	htmlContent := "<div style=\"font-family: sans-serif; max-width: 600px; margin: 40px auto; padding: 30px; border: 1px solid #e1e4e8; border-radius: 8px;\">" +
		"<h2 style=\"color: #333; margin-top: 0;\">SMTP 配置测试</h2>" +
		"<p style=\"color: #555; line-height: 1.6;\">这是一封来自 <strong>" + svc.SiteName() + "</strong> 的测试邮件。</p>" +
		"<p style=\"color: #555; line-height: 1.6;\">如果收到此邮件，说明 SMTP 配置正确，邮件通知功能可以正常使用。</p>" +
		"<hr style=\"border: none; border-top: 1px solid #eee; margin: 24px 0;\">" +
		"<p style=\"color: #999; font-size: 12px;\">此邮件由系统自动发送，请勿直接回复。</p></div>"

	if err := svc.SendRaw(adminEmail, "SMTP 配置验证", htmlContent); err != nil {
		log.Printf("[ERROR] Test email failed: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    400,
			"message": "邮件发送失败，请检查 SMTP 配置",
		})
		return
	}

	log.Printf("[INFO] Test email sent to: %s", adminEmail)
	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "A test email has been sent",
	})
}

func (h *CommentHandler) ChangePassword(c *gin.Context) {
	var req struct {
		OldName     string `json:"old_name"`
		OldPassword string `json:"old_password"`
		NewName     string `json:"new_name"`
		NewPassword string `json:"new_password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid request body",
		})
		return
	}

	if req.OldName == "" || req.OldPassword == "" || req.NewName == "" || req.NewPassword == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "old_name, old_password, new_name, new_password are required",
		})
		return
	}

	if len(req.NewPassword) < 8 {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "New password must be at least 8 characters",
		})
		return
	}

	if !utils.CheckAdminCredentials(req.OldName, req.OldPassword) {
		c.JSON(http.StatusUnauthorized, gin.H{
			"code":    400,
			"message": "Current credentials are incorrect",
		})
		return
	}

	if err := utils.ChangeAdminPassword(req.NewName, req.NewPassword); err != nil {
		log.Printf("[ERROR] Failed to change password: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Failed to update credentials",
		})
		return
	}

	log.Printf("[INFO] Admin credentials changed: %s -> %s", req.OldName, req.NewName)
	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Admin credentials updated successfully. Please login again.",
	})
}

func (h *CommentHandler) ListAllComments(c *gin.Context) {
	// 1. 解析分页参数和状态筛选
	pageStr := c.DefaultQuery("page", "1")
	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{
			"code":    400,
			"message": "Invalid query parameters",
		})
		return
	}

	status := c.DefaultQuery("status", "")
	limit := 10
	offset := (page - 1) * limit

	// 2. 从 Repo 调用获取数据
	comments, total, err := h.Repo.List(c.Request.Context(), offset, limit, status)
	if err != nil {
		log.Printf("[ERROR] Failed to list comments: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Failed to fetch comments",
		})
		return
	}

	// 3. 计算总页数
	totalPage := int((total + int64(limit) - 1) / int64(limit))
	if total == 0 {
		totalPage = 0
	}

	// 4. 构造响应数据 (处理时间格式及字段映射)
	respComments := make([]model.AdminCommentResponse, 0)
	for _, comm := range comments {
		respComments = append(respComments, model.AdminCommentResponse{
			ID:          comm.ID,
			PubDate:     time.UnixMilli(comm.PubDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			PostSlug:    comm.PostSlug,
			Author:      comm.Author,
			Email:       comm.Email,
			URL:         comm.URL,
			IPAddress:   comm.IPAddress,
			OS:          comm.OS,
			Browser:     comm.Browser,
			ContentText: comm.ContentText,
			ContentHtml: comm.ContentHTML,
			Status:      comm.Status,
		})
	}

	// 5. 返回符合文档要求的 JSON
	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Comments fetched successfully",
		"data": gin.H{
			"comments": respComments,
			"pagination": gin.H{
				"page":      page,
				"limit":     limit,
				"totalPage": totalPage,
			},
		},
	})
}

// UpdateCommentStatus 修改评论状态
func (h *CommentHandler) UpdateCommentStatus(c *gin.Context) {
	idStr := c.Query("id")
	status := c.Query("status")
	id, err := strconv.ParseInt(idStr, 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid id"})
		return
	}

	if err := h.Repo.UpdateStatus(c.Request.Context(), id, status); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    400,
			"message": "Invalid request parameters",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Comment status updated",
	})
}

// UpdateComment 修改评论内容
func (h *CommentHandler) UpdateComment(c *gin.Context) {
	var req struct {
		ID          int64   `json:"id" binding:"required"`
		Author      *string `json:"author"`
		Email       *string `json:"email"`
		ContentText *string `json:"content_text"`
		ContentHtml *string `json:"content_html"`
		URL         *string `json:"url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid request parameters"})
		return
	}

	fields := make(map[string]interface{})
	if req.Author != nil {
		fields["author"] = *req.Author
	}
	if req.Email != nil {
		fields["email"] = *req.Email
	}
	if req.ContentText != nil {
		fields["content_text"] = *req.ContentText
		// 只改了 content_text 但没传 content_html 时，自动渲染 markdown
		if req.ContentHtml == nil {
			fields["content_html"] = utils.ParseMarkdown(*req.ContentText)
		}
	}
	if req.ContentHtml != nil {
		fields["content_html"] = *req.ContentHtml
	}
	if req.URL != nil {
		fields["url"] = *req.URL
	}
	if len(fields) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "No fields to update"})
		return
	}

	if err := h.Repo.UpdateComment(c.Request.Context(), req.ID, fields); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Update failed"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Comment updated",
	})
}

// GetStatsOverview 统计概览
func (h *CommentHandler) GetStatsOverview(c *gin.Context) {
	rangeStr := c.DefaultQuery("range", "7")
	stats, err := h.Repo.GetStatsOverview(c.Request.Context(), rangeStr)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"code":    500,
			"message": "Failed to fetch stats",
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Stats fetched successfully",
		"data":    stats,
	})
}

// GetUserList 用户列表（支持按昵称/邮箱搜索，标记黑名单状态）
func (h *CommentHandler) GetUserList(c *gin.Context) {
	pageStr := c.DefaultQuery("page", "1")
	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid query parameters"})
		return
	}

	limitStr := c.DefaultQuery("limit", "20")
	limit, err := strconv.Atoi(limitStr)
	if err != nil || limit < 1 {
		limit = 20
	}

	search := strings.TrimSpace(c.DefaultQuery("search", ""))

	offset := (page - 1) * limit
	users, total, err := h.Repo.GetUserList(c.Request.Context(), offset, limit, search)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to fetch users"})
		return
	}

	// 标记邮箱黑名单状态（不区分大小写）
	emailBlacklist := getEmailBlacklist()
	for _, u := range users {
		for _, entry := range emailBlacklist {
			if strings.EqualFold(entry, u.Email) {
				u.Blacklisted = true
				break
			}
		}
	}

	totalPage := int64((total + int64(limit) - 1) / int64(limit))
	if total == 0 {
		totalPage = 0
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Users fetched successfully",
		"data": gin.H{
			"users": users,
			"pagination": gin.H{
				"page":      page,
				"limit":     limit,
				"totalPage": totalPage,
			},
		},
	})
}

// getEmailBlacklist 读取邮箱黑名单（JSON 数组）
func getEmailBlacklist() []string {
	raw := utils.GetSetting("email_blacklist")
	if raw == "" {
		return nil
	}
	var list []string
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil
	}
	return list
}

// AddUserToBlacklist 一键将用户（按邮箱）加入黑名单
func (h *CommentHandler) AddUserToBlacklist(c *gin.Context) {
	var req struct {
		Email string `json:"email"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid request body"})
		return
	}
	email := strings.ToLower(strings.TrimSpace(req.Email))
	if email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "email is required"})
		return
	}

	list := getEmailBlacklist()
	for _, entry := range list {
		if strings.EqualFold(entry, email) {
			c.JSON(http.StatusOK, gin.H{
				"code":    200,
				"message": "User is already in blacklist",
				"data":    gin.H{"email": email, "blacklisted": true},
			})
			return
		}
	}

	list = append(list, email)
	if err := utils.SetSetting("email_blacklist", mustJSON(list)); err != nil {
		log.Printf("[ERROR] Failed to add user to blacklist: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to update blacklist"})
		return
	}
	log.Printf("[WARN] User added to email blacklist: %s", email)

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "User added to blacklist",
		"data":    gin.H{"email": email, "blacklisted": true},
	})
}

// RemoveUserFromBlacklist 将用户（按邮箱）移出黑名单
func (h *CommentHandler) RemoveUserFromBlacklist(c *gin.Context) {
	email := strings.ToLower(strings.TrimSpace(c.Query("email")))
	if email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "email is required"})
		return
	}

	list := getEmailBlacklist()
	index := -1
	for i, entry := range list {
		if strings.EqualFold(entry, email) {
			index = i
			break
		}
	}
	if index == -1 {
		c.JSON(http.StatusOK, gin.H{
			"code":    200,
			"message": "User is not in blacklist",
			"data":    gin.H{"email": email, "blacklisted": false},
		})
		return
	}

	list = append(list[:index], list[index+1:]...)
	if err := utils.SetSetting("email_blacklist", mustJSON(list)); err != nil {
		log.Printf("[ERROR] Failed to remove user from blacklist: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to update blacklist"})
		return
	}
	log.Printf("[INFO] User removed from email blacklist: %s", email)

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "User removed from blacklist",
		"data":    gin.H{"email": email, "blacklisted": false},
	})
}

// mustJSON 将值序列化为 JSON 字符串（失败时返回空数组）
func mustJSON(v interface{}) string {
	data, err := json.Marshal(v)
	if err != nil {
		return "[]"
	}
	return string(data)
}

// GetUserComments 获取指定用户的评论
func (h *CommentHandler) GetUserComments(c *gin.Context) {
	author := c.Query("author")
	email := c.Query("email")
	if author == "" || email == "" {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "author and email are required"})
		return
	}

	pageStr := c.DefaultQuery("page", "1")
	page, err := strconv.Atoi(pageStr)
	if err != nil || page < 1 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "Invalid query parameters"})
		return
	}

	limit := 10
	offset := (page - 1) * limit

	comments, total, err := h.Repo.GetUserComments(c.Request.Context(), author, email, offset, limit)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to fetch comments"})
		return
	}

	totalPage := int64((total + int64(limit) - 1) / int64(limit))
	if total == 0 {
		totalPage = 0
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "User comments fetched successfully",
		"data": gin.H{
			"comments": comments,
			"pagination": gin.H{
				"page":      page,
				"limit":     limit,
				"totalPage": totalPage,
			},
		},
	})
}

// ExportSettings 导出系统设置（含 email_password，不含 admin_name/admin_password）
func (h *CommentHandler) ExportSettings(c *gin.Context) {
	all := utils.GetAllSettings()
	filtered := make(map[string]string)
	allowList := map[string]bool{
		"site_name": true, "admin_email": true,
		"smtp_host": true, "smtp_port": true, "email_user": true, "email_password": true, "email_secure": true,
		"admin_comment_key": true,
		"allow_origin":      true, "email_enabled": true,
		"reply_template": true, "notification_template": true,
	"ip_blacklist":          true,
	"email_blacklist":       true,
	"blogger_badge_enabled": true,
	"blogger_badge_text":    true,
	"placeholder_name":      true,
	"placeholder_email":     true,
	"placeholder_content":   true,
	"placeholder_url":       true,
	"email_verify_enabled":  true,
	"verify_base_url":       true,
	"comment_auto_approve":  true,
	"admin_comment_key_enabled": true,
	"comment_verify_enabled":    true,
	"comment_verify_difficulty": true,
	}
	for key := range allowList {
		if val, ok := all[key]; ok {
			filtered[key] = val
		}
	}
	if _, ok := filtered["email_enabled"]; !ok {
		filtered["email_enabled"] = "true"
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Settings exported",
		"data": gin.H{
			"exportedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			"type":       "settings",
			"version":    h.Version,
			"settings":   filtered,
		},
	})
}

// ExportComments 导出评论数据
func (h *CommentHandler) ExportComments(c *gin.Context) {
	allComments, err := h.Repo.ListAll(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": 500, "message": "Failed to export comments"})
		return
	}

	resp := make([]model.AdminCommentResponse, 0)
	for _, comm := range allComments {
		resp = append(resp, model.AdminCommentResponse{
			ID:          comm.ID,
			PubDate:     time.UnixMilli(comm.PubDate).UTC().Format("2006-01-02T15:04:05.000Z"),
			PostSlug:    comm.PostSlug,
			Author:      comm.Author,
			Email:       comm.Email,
			URL:         comm.URL,
			IPAddress:   comm.IPAddress,
			OS:          comm.OS,
			Browser:     comm.Browser,
			ContentText: comm.ContentText,
			ContentHtml: comm.ContentHTML,
			Status:      comm.Status,
		})
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "Comments exported",
		"data": gin.H{
			"exportedAt": time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
			"type":       "comments",
			"version":    h.Version,
			"total":      len(resp),
			"comments":   resp,
		},
	})
}

// ImportComments 导入评论数据
func (h *CommentHandler) ImportComments(c *gin.Context) {
	var body struct {
		Comments []struct {
			PostSlug    string  `json:"postSlug"`
			Author      string  `json:"author"`
			Email       string  `json:"email"`
			URL         *string `json:"url"`
			IPAddress   *string `json:"ipAddress"`
			OS          *string `json:"os"`
			Browser     *string `json:"browser"`
			ContentText string  `json:"contentText"`
			ContentHtml string  `json:"contentHtml"`
			ParentID    *int64  `json:"parentId"`
			Status      string  `json:"status"`
			PubDate     string  `json:"pubDate"`
		} `json:"comments"`
	}
	if err := c.ShouldBindJSON(&body); err != nil || len(body.Comments) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "请求体须包含 comments 数组"})
		return
	}

	imported := 0
	var errors []string
	for i, cData := range body.Comments {
		if cData.PostSlug == "" || cData.Author == "" || cData.Email == "" || cData.ContentText == "" {
			errors = append(errors, "第 "+strconv.Itoa(i+1)+" 条缺少必填字段")
			continue
		}
		pubDate := time.Now().UnixMilli()
		if cData.PubDate != "" {
			if t, err := time.Parse("2006-01-02T15:04:05.000Z", cData.PubDate); err == nil {
				pubDate = t.UnixMilli()
			} else if t, err := time.Parse("2006-01-02T15:04:05Z", cData.PubDate); err == nil {
				pubDate = t.UnixMilli()
			}
		}
		comment := &model.Comment{
			PostSlug:    cData.PostSlug,
			Author:      cData.Author,
			Email:       cData.Email,
			URL:         cData.URL,
			IPAddress:   cData.IPAddress,
			OS:          cData.OS,
			Browser:     cData.Browser,
			ContentText: cData.ContentText,
			ContentHTML: cData.ContentHtml,
			ParentID:    cData.ParentID,
			Status:      "approved",
			PubDate:     pubDate,
		}
		if cData.Status != "" {
			comment.Status = cData.Status
		}
		if err := h.Repo.Create(c.Request.Context(), comment); err != nil {
			log.Printf("[ERROR] Import failed for comment #%d: %v", i+1, err)
			errors = append(errors, "第 "+strconv.Itoa(i+1)+" 条导入失败，请检查数据格式")
			continue
		}
		imported++
	}

	resp := gin.H{"imported": imported}
	if len(errors) > 0 {
		resp["errors"] = errors
	}
	c.JSON(http.StatusOK, gin.H{
		"code": 200,
		"message": "导入完成，成功 " + strconv.Itoa(imported) + " 条" + func() string {
			if len(errors) > 0 {
				return "，失败 " + strconv.Itoa(len(errors)) + " 条"
			}
			return ""
		}(),
		"data": resp,
	})
}

// ImportSettings 导入系统设置
func (h *CommentHandler) ImportSettings(c *gin.Context) {
	var body map[string]string
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": 400, "message": "请提供有效的设置数据"})
		return
	}

	allowList := map[string]bool{
		"site_name": true, "admin_email": true, "admin_name": true,
		"smtp_host": true, "smtp_port": true, "email_user": true, "email_password": true, "email_secure": true,
		"admin_comment_key": true,
		"ip_blacklist":          true,
		"email_blacklist":       true,
		"blogger_badge_enabled": true,
		"blogger_badge_text":    true,
		"placeholder_name":      true,
		"placeholder_email":     true,
		"placeholder_content":   true,
		"placeholder_url":       true,
		"email_verify_enabled":  true,
		"verify_base_url":       true,
		"comment_auto_approve":  true,
		"admin_comment_key_enabled": true,
		"comment_verify_enabled":    true,
		"comment_verify_difficulty": true,
		"allow_origin":      true, "email_enabled": true,
		"reply_template": true, "notification_template": true,
	}

	updated := 0
	for key, value := range body {
		if allowList[key] && value != "" {
			if err := utils.SetSetting(key, value); err == nil {
				updated++
			}
		}
	}

	c.JSON(http.StatusOK, gin.H{
		"code":    200,
		"message": "设置导入完成，已更新 " + strconv.Itoa(updated) + " 项",
		"data":    gin.H{"updated": updated},
	})
}
