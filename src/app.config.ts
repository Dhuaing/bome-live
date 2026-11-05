export default defineAppConfig({
  pages: [
    'pages/home/index',
    'pages/subscribe/index',
    'pages/mine/index',
    'pages/streamer-detail/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#FFFFFF',
    navigationBarTitleText: '播了么',
    navigationBarTextStyle: 'black'
  },
  tabBar: {
    color: '#8E8E93',
    selectedColor: '#FE2C55',
    backgroundColor: '#FFFFFF',
    borderStyle: 'white',
    // 注意：微信小程序 tabBar 的 iconPath 只支持 png/jpg/jpeg，不支持 svg。
    // 这里的 png 由 scripts/svg2png-tabbar.js 从同名 svg 渲染（81×81）。
    list: [
      {
        pagePath: 'pages/home/index',
        text: '首页',
        iconPath: 'assets/tabbar/home.png',
        selectedIconPath: 'assets/tabbar/home-selected.png'
      },
      {
        pagePath: 'pages/subscribe/index',
        text: '订阅',
        iconPath: 'assets/tabbar/subscribe.png',
        selectedIconPath: 'assets/tabbar/subscribe-selected.png'
      },
      {
        pagePath: 'pages/mine/index',
        text: '我的',
        iconPath: 'assets/tabbar/mine.png',
        selectedIconPath: 'assets/tabbar/mine-selected.png'
      }
    ]
  }
})
