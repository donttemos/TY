// vitest.config.ts
import { defineConfig } from "file:///F:/WorkBuddy/TY/node_modules/.pnpm/vitest@2.1.9_@types+node@22.20.5/node_modules/vitest/dist/config.js";
var vitest_config_default = defineConfig({
  test: {
    include: ["src/**/__tests__/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 仅统计 src 业务代码，不含测试自身
      include: ["src/**/*.ts"],
      exclude: ["src/__tests__/**", "src/**/*.d.ts", "src/**/index.ts"],
      thresholds: {
        // 全局门槛：项目计划 §6 要求 orm 覆盖率 ≥ 85%
        lines: 85,
        functions: 85,
        branches: 65,
        statements: 85
      }
    }
  }
});
export {
  vitest_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZXN0LmNvbmZpZy50cyJdLAogICJzb3VyY2VzQ29udGVudCI6IFsiY29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2Rpcm5hbWUgPSBcIkY6XFxcXFdvcmtCdWRkeVxcXFxUWVxcXFxwYWNrYWdlc1xcXFxkYlwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiRjpcXFxcV29ya0J1ZGR5XFxcXFRZXFxcXHBhY2thZ2VzXFxcXGRiXFxcXHZpdGVzdC5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0Y6L1dvcmtCdWRkeS9UWS9wYWNrYWdlcy9kYi92aXRlc3QuY29uZmlnLnRzXCI7LypcbiAqIEBmaWxlIHZpdGVzdCBcdTkxNERcdTdGNkVcdUZGMUFcdTUzNTVcdTZENEIgKyBcdTg5ODZcdTc2RDZcdTczODdcdTk1RThcdTc5ODFcbiAqIEBkZXNjcmlwdGlvbiBAZncvZGIgXHU4OTg2XHU3NkQ2XHU3Mzg3XHU5NjA4XHU1MDNDXHU1QkY5XHU5RjUwIFBSRC0wMDJcdUZGMDhvcm0gXHUyMjY1IDg1JVx1RkYwOVx1RkYxQWxpbmVzL2Z1bmN0aW9ucy9zdGF0ZW1lbnRzIFx1MjI2NSA4NSVcdUZGMENicmFuY2hlcyBcdTIyNjUgNjUlXG4gKiBAYXV0aG9yIGRvbnR0ZW1vXG4gKiBAY3JlYXRlZCAyMDI2LTEwLTEyXG4gKiBAbW9kdWxlIEBmdy9kYlxuICovXG5pbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlc3QvY29uZmlnJztcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKHtcbiAgdGVzdDoge1xuICAgIGluY2x1ZGU6IFsnc3JjLyoqL19fdGVzdHNfXy8qKi8qLnRlc3QudHMnXSxcbiAgICBjb3ZlcmFnZToge1xuICAgICAgcHJvdmlkZXI6ICd2OCcsXG4gICAgICByZXBvcnRlcjogWyd0ZXh0JywgJ2pzb24tc3VtbWFyeSddLFxuICAgICAgLy8gXHU0RUM1XHU3RURGXHU4QkExIHNyYyBcdTRFMUFcdTUyQTFcdTRFRTNcdTc4MDFcdUZGMENcdTRFMERcdTU0MkJcdTZENEJcdThCRDVcdTgxRUFcdThFQUJcbiAgICAgIGluY2x1ZGU6IFsnc3JjLyoqLyoudHMnXSxcbiAgICAgIGV4Y2x1ZGU6IFsnc3JjL19fdGVzdHNfXy8qKicsICdzcmMvKiovKi5kLnRzJywgJ3NyYy8qKi9pbmRleC50cyddLFxuICAgICAgdGhyZXNob2xkczoge1xuICAgICAgICAvLyBcdTUxNjhcdTVDNDBcdTk1RThcdTY5REJcdUZGMUFcdTk4NzlcdTc2RUVcdThCQTFcdTUyMTIgXHUwMEE3NiBcdTg5ODFcdTZDNDIgb3JtIFx1ODk4Nlx1NzZENlx1NzM4NyBcdTIyNjUgODUlXG4gICAgICAgIGxpbmVzOiA4NSxcbiAgICAgICAgZnVuY3Rpb25zOiA4NSxcbiAgICAgICAgYnJhbmNoZXM6IDY1LFxuICAgICAgICBzdGF0ZW1lbnRzOiA4NSxcbiAgICAgIH0sXG4gICAgfSxcbiAgfSxcbn0pO1xuIl0sCiAgIm1hcHBpbmdzIjogIjtBQU9BLFNBQVMsb0JBQW9CO0FBRTdCLElBQU8sd0JBQVEsYUFBYTtBQUFBLEVBQzFCLE1BQU07QUFBQSxJQUNKLFNBQVMsQ0FBQywrQkFBK0I7QUFBQSxJQUN6QyxVQUFVO0FBQUEsTUFDUixVQUFVO0FBQUEsTUFDVixVQUFVLENBQUMsUUFBUSxjQUFjO0FBQUE7QUFBQSxNQUVqQyxTQUFTLENBQUMsYUFBYTtBQUFBLE1BQ3ZCLFNBQVMsQ0FBQyxvQkFBb0IsaUJBQWlCLGlCQUFpQjtBQUFBLE1BQ2hFLFlBQVk7QUFBQTtBQUFBLFFBRVYsT0FBTztBQUFBLFFBQ1AsV0FBVztBQUFBLFFBQ1gsVUFBVTtBQUFBLFFBQ1YsWUFBWTtBQUFBLE1BQ2Q7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
