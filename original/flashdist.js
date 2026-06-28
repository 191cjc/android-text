function whatBrowser() {
	var type = "";
	if (window.navigator.userAgent.indexOf('compatible') != -1) {
		type = "compatible";
	}else if (window.navigator.userAgent.indexOf('Trident') != -1) {
		type = "compatible";
	}else if(window.navigator.userAgent.indexOf('AppleWebKit') != -1) {
		type = "AppleWebKit";
	}
	return type;
}  
function browserRedirect() {
	var isdesktop = 0;
	var sUserAgent = navigator.userAgent.toLowerCase();
	var bIsIpad = sUserAgent.match(/ipad/i) == "ipad";
	var bIsIphoneOs = sUserAgent.match(/iphone os/i) == "iphone os";
	var bIsMidp = sUserAgent.match(/midp/i) == "midp";
	var bIsUc7 = sUserAgent.match(/rv:1.2.3.4/i) == "rv:1.2.3.4";
	var bIsUc = sUserAgent.match(/ucweb/i) == "ucweb";
	var bIsAndroid = sUserAgent.match(/android/i) == "android";
	var bIsCE = sUserAgent.match(/windows ce/i) == "windows ce";
	var bIsWM = sUserAgent.match(/windows mobile/i) == "windows mobile";
	if (bIsIpad || bIsIphoneOs || bIsMidp || bIsUc7 || bIsUc || bIsAndroid || bIsCE || bIsWM) {
		isdesktop = 0;
	} else {
		isdesktop = 1;
	}
	return isdesktop;
} 

if(browserRedirect()==1){
	var types = whatBrowser();
	if(types=="compatible"){
		document.getElementById("downloader").href = "//www.flash.cn/download-wins";
		document.getElementById("meth2").style.display = "block";
		document.getElementById("downloader").setAttribute("target","_blank");
	}else if(types=="AppleWebKit"){
		document.getElementById("downloader").href = "//www.flash.cn/download-wins";
		document.getElementById("meth2").style.display = "block";
		document.getElementById("downloader").setAttribute("target","_blank");
	}else{
		document.getElementById("downloader").onclick = function(){
			alert("该浏览器不支持flash插件");
			return false;
		}
	}
}