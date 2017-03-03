package gui.items.statement;

import java.math.BigDecimal;
import java.nio.charset.Charset;
import java.util.List;

import org.mapdb.Fun.Tuple2;

import com.github.rjeschke.txtmark.Processor;

import core.item.ItemCls;
import core.item.notes.NoteCls;
import core.transaction.R_SignNote;
import core.transaction.Transaction;
import database.DBSet;
import gui.library.Voush_Library_Panel;
import lang.Lang;

/*
 * To change this license header, choose License Headers in Project Properties.
 * To change this template file, choose Tools | Templates
 * and open the template in the editor.
 */

/**
 *
 * @author Саша
 */
public class Statement_Info extends javax.swing.JPanel {

	/**
	 * Creates new form Statement_Info
	 * 
	 * @param statement
	 */
	R_SignNote statement;
	Transaction transaction;

	public Statement_Info(Transaction transaction) {
		this.transaction = transaction;
		initComponents();

		Tuple2<BigDecimal, List<Tuple2<Integer, Integer>>> signs = DBSet.getInstance().getVouchRecordMap()
				.get(transaction.getBlockHeight(DBSet.getInstance()), transaction.getSeqNo(DBSet.getInstance()));

		if (signs != null) {

		}

		statement = (R_SignNote) transaction;
		NoteCls note = (NoteCls) ItemCls.getItem(DBSet.getInstance(), ItemCls.NOTE_TYPE, statement.getKey());
		jTextArea_Body.setContentType("text/html");
		jTextArea_Body.setText(note.getName() + "\n\n" + note.getDescription() + "\n\n"
				+ Processor.process(new String(statement.getData(), Charset.forName("UTF-8"))));

		jSplitPane1.setDividerLocation(350);// .setDividerLocation((int)(jSplitPane1.getSize().getHeight()/0.5));//.setLastDividerLocation(0);

	}

	/**
	 * This method is called from within the constructor to initialize the form.
	 * WARNING: Do NOT modify this code. The content of this method is always
	 * regenerated by the Form Editor.
	 */
	@SuppressWarnings("unchecked")
	// <editor-fold defaultstate="collapsed" desc="Generated Code">
	private void initComponents() {
		java.awt.GridBagConstraints gridBagConstraints;

		jLabel_Title = new javax.swing.JLabel();
		jSplitPane1 = new javax.swing.JSplitPane();
		jPanel1 = new javax.swing.JPanel();
		jScrollPane3 = new javax.swing.JScrollPane();
		jTextArea_Body = new javax.swing.JTextPane();
		jPanel2 = new javax.swing.JPanel();
		new javax.swing.JLabel();

		// jTable_Sign = new javax.swing.JTable();

		setLayout(new java.awt.GridBagLayout());

		jLabel_Title.setText(Lang.getInstance().translate("Statement"));
		gridBagConstraints = new java.awt.GridBagConstraints();
		gridBagConstraints.gridx = 0;
		gridBagConstraints.gridy = 0;
		gridBagConstraints.fill = java.awt.GridBagConstraints.HORIZONTAL;
		gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
		gridBagConstraints.weightx = 0.2;
		gridBagConstraints.insets = new java.awt.Insets(11, 11, 0, 11);
		add(jLabel_Title, gridBagConstraints);

		jSplitPane1.setBorder(null);
		jSplitPane1.setOrientation(javax.swing.JSplitPane.VERTICAL_SPLIT);

		jPanel1.setLayout(new java.awt.GridBagLayout());

		// jTextArea_Body.setColumns(20);
		// jTextArea_Body.setRows(5);
		// jScrollPane3.setViewportView(jTextArea_Body);
		jScrollPane3.getViewport().add(jTextArea_Body);

		gridBagConstraints = new java.awt.GridBagConstraints();
		gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
		gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
		gridBagConstraints.weightx = 0.1;
		gridBagConstraints.weighty = 0.1;
		gridBagConstraints.insets = new java.awt.Insets(11, 11, 11, 11);
		jPanel1.add(jScrollPane3, gridBagConstraints);

		jSplitPane1.setLeftComponent(jPanel1);

		jPanel2.setLayout(new java.awt.GridBagLayout());

		gridBagConstraints = new java.awt.GridBagConstraints();
		gridBagConstraints.gridx = 0;
		gridBagConstraints.gridy = 1;
		gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
		gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
		gridBagConstraints.weightx = 0.1;
		gridBagConstraints.weighty = 0.1;
		gridBagConstraints.insets = new java.awt.Insets(0, 11, 11, 11);

		jPanel2.add(new Voush_Library_Panel(transaction), gridBagConstraints);
		//

		jSplitPane1.setRightComponent(jPanel2);

		gridBagConstraints = new java.awt.GridBagConstraints();
		gridBagConstraints.gridx = 0;
		gridBagConstraints.gridy = 1;
		gridBagConstraints.fill = java.awt.GridBagConstraints.BOTH;
		gridBagConstraints.anchor = java.awt.GridBagConstraints.FIRST_LINE_START;
		gridBagConstraints.weightx = 0.1;
		gridBagConstraints.weighty = 0.1;
		add(jSplitPane1, gridBagConstraints);
	}// </editor-fold>

	private javax.swing.JLabel jLabel_Title;
	private javax.swing.JPanel jPanel1;
	private javax.swing.JPanel jPanel2;
	private javax.swing.JScrollPane jScrollPane3;

	private javax.swing.JSplitPane jSplitPane1;

	private javax.swing.JTextPane jTextArea_Body;
	// End of variables declaration
}
