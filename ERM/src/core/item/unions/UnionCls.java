package core.item.unions;

//import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
 import org.apache.log4j.Logger;

import org.json.simple.JSONObject;

import com.google.common.primitives.Bytes;
import com.google.common.primitives.Ints;
import com.google.common.primitives.Longs;

import controller.Controller;
import core.account.Account;
import core.crypto.Base58;
import core.crypto.Crypto;
import core.item.ItemCls;
import core.transaction.Transaction;
import database.DBSet;
import database.Issue_ItemMap;
import database.Item_Map;
import utils.ByteArrayUtils;
import utils.DateTimeFormat;
import database.ItemUnionMap;

public abstract class UnionCls extends ItemCls{

	public static final int UNION = 1;

	protected static final int BIRTHDAY_LENGTH = ItemCls.TIMESTAMP_LENGTH;
	protected static final int PARENT_LENGTH = Transaction.KEY_LENGTH;
	protected static final int BASE_LENGTH = ItemCls.BASE_LENGTH
			+ BIRTHDAY_LENGTH + PARENT_LENGTH;

	// TODO add setNote - document for birth union
	protected long birthday; // timestamp
	protected long parent; // parent union

	public UnionCls(byte[] typeBytes, Account creator, String name, long birthday, long parent, String description)
	{
		super(typeBytes, creator, name, description);
		this.birthday = birthday;
		this.parent = parent;

	}
	public UnionCls(int type, Account creator, String name, long birthday, long parent, String description)
	{
		this(new byte[TYPE_LENGTH], creator, name, birthday, parent, description);
		this.typeBytes[0] = (byte)type;
	}

	//GETTERS/SETTERS
	public int getItemTypeInt() { return ItemCls.UNION_TYPE; }
	public String getItemTypeStr() { return "union"; }
	
	public long getBirthday() {
		return this.birthday;
	}
	public long getParent() {
		return this.parent;
	}

	// DB
	public Item_Map getDBMap(DBSet db)
	{
		return db.getItemUnionMap();
	}
	public Issue_ItemMap getDBIssueMap(DBSet db)
	{
		return db.getIssueUnionMap();
	}

	// PARSE
	public byte[] toBytes(boolean includeReference)
	{
		
		byte[] data = super.toBytes(includeReference);
				
		// WRITE BIRTHDAY
		byte[] birthdayBytes = Longs.toByteArray(this.birthday);
		birthdayBytes = Bytes.ensureCapacity(birthdayBytes, BIRTHDAY_LENGTH, 0);
		data = Bytes.concat(data, birthdayBytes);
		
		// WRITE PARENT
		byte[] parentBytes = Longs.toByteArray(this.parent);
		parentBytes = Bytes.ensureCapacity(parentBytes, PARENT_LENGTH, 0);
		data = Bytes.concat(data, parentBytes);
		

		return data;
	}

	@Override
	public int getDataLength(boolean includeReference) 
	{
		return BASE_LENGTH
				+ this.name.getBytes(StandardCharsets.UTF_8).length
				+ this.description.getBytes(StandardCharsets.UTF_8).length
				+ (includeReference? REFERENCE_LENGTH: 0);

	}	
	
	//OTHER

	@Override
	public String toString(DBSet db)
	{
		long key = this.getKey(db);
		return "(" + (key<0?"? ":key) + ":" + this.typeBytes[0] + ") " + this.name
				+ " !" + parent + " " + DateTimeFormat.timestamptoString(birthday, "dd-MM-YY","") ;
	}
	
	@Override
	public String getShort(DBSet db)
	{
		long key = this.getKey(db);
		return "(" + (key<0?"? ":key) + ":" + this.typeBytes[0] + ") "
				+ this.name.substring(0, Math.min(this.name.length(), 20))
				+ " !" + parent + " " + DateTimeFormat.timestamptoString(birthday, "dd-MM-YY","") ;
	}
	
	@SuppressWarnings("unchecked")
	public JSONObject toJson() {
		
		JSONObject personJSON = super.toJson();

		// ADD DATA
		personJSON.put("birthday", this.birthday);
		personJSON.put("parent", this.parent);
				
		return personJSON;
	}
	

}
